import { performance } from 'node:perf_hooks';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';
import {
  TRANSFORMATION_TYPES,
  type TransformationStatus,
  type TransformationType,
} from '@/modules/transformations/transformation.types';
import { uuidOrNull } from '@/modules/users/user-ids';
import { validateUserId } from '@/modules/users/user-list-query';

import { decodeHistoryCursor, encodeHistoryCursor } from './history-cursor';
import {
  type HistoryFilters,
  type HistoryQuery,
  type KnownFormats,
  parseHistoryQuery,
} from './history-query';

/** Spec 2.3 §1.3.4 (storage fields fixed until spec 2.4). */
export interface TransformationHistoryItem {
  id: string;
  type: TransformationType;
  sourceFormat: string;
  targetFormat: string;
  status: TransformationStatus;
  inputSize: number;
  outputSize: number | null;
  durationMs: number;
  errorCode: string | null;
  createdAt: string;
  storageStatus: 'not_requested' | 'pending' | 'available' | 'error';
  hasStoredFile: boolean;
  fileExpiresAt: string | null;
}

export interface HistoryPage {
  items: TransformationHistoryItem[];
  nextCursor: string | null;
}

interface Row {
  id: string;
  type: TransformationType;
  source_format: string;
  target_format: string;
  status: TransformationStatus;
  input_size: string;
  output_size: string | null;
  duration_ms: number;
  error_code: string | null;
  created_at: Date;
}

/** What the audit line may carry (spec 2.3 §1.5): never the cursor, never a filter value. */
interface Audit {
  scope: 'self' | 'admin';
  targetUserId?: string;
  filters?: string[];
  limit?: number;
  count?: number;
}

const FIELDS =
  'id, type, source_format, target_format, status, input_size, output_size, duration_ms, error_code, created_at';
const FILTER_NAMES: (keyof HistoryFilters)[] = [
  'type',
  'sourceFormat',
  'targetFormat',
  'status',
  'createdAtFrom',
  'createdAtTo',
];
const SLOW_MS = 500;

/**
 * Spec 2.3: pages of finished transformations, newest first (`created_at DESC, id DESC`), keyset
 * only (no OFFSET, no count), `limit + 1` rows of the response fields through
 * `idx_transformations_user_created_at_id`, inside a transaction with a 2-second SQL timeout like
 * the user list (D51).
 */
@Injectable()
export class TransformationHistoryService {
  private readonly logger = new Logger('TransformationHistory');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly registry: ConverterRegistry,
  ) {}

  /** Own history: the user id comes from the verified session (spec 2.3 §1.3.2 step 3). */
  own(actor: string, rawQuery: unknown): Promise<HistoryPage> {
    return this.audited(actor, { scope: 'self' }, (audit) =>
      this.page(actor, this.parse(rawQuery, audit), audit),
    );
  }

  /**
   * Someone's history (spec 2.3 §1.3.3). The guard already required `history_any`, so the lookup
   * happens only after the permission: an absent user is 404, never a hint to an outsider.
   */
  ofUser(
    actor: string,
    target: string,
    rawQuery: unknown,
  ): Promise<HistoryPage> {
    return this.audited(actor, { scope: 'admin' }, async (audit) => {
      validateUserId(target);
      const query = this.parse(rawQuery, audit);
      const [user] = await this.db.query<{ id: string }[]>(
        `SELECT id FROM users WHERE id = $1`,
        [uuidOrNull(target)],
      );
      if (!user) throw new AppException('not_found');
      audit.targetUserId = user.id;
      return this.page(user.id, query, audit);
    });
  }

  private parse(raw: unknown, audit: Audit): HistoryQuery {
    const query = parseHistoryQuery(raw, this.formats());
    audit.limit = query.filters.limit;
    audit.filters = [
      ...FILTER_NAMES.filter((name) => query.filters[name] !== null),
      ...(query.cursor ? ['cursor'] : []),
    ];
    return query;
  }

  /** Every registered source and target, so a new pair is filterable without a code change. */
  private formats(): KnownFormats {
    const sources = new Set<string>();
    const targets = new Set<string>();
    for (const type of TRANSFORMATION_TYPES)
      for (const { source, target } of this.registry.directions(type)) {
        sources.add(source);
        for (const name of target) targets.add(name);
      }
    return { sources, targets };
  }

  private async page(
    userId: string,
    { filters, cursor }: HistoryQuery,
    audit: Audit,
  ): Promise<HistoryPage> {
    const position = cursor ? decodeHistoryCursor(cursor, filters) : null;
    const params: unknown[] = [userId];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions = ['user_id = $1'];
    if (filters.type) conditions.push(`type = ${bind(filters.type)}`);
    if (filters.sourceFormat)
      conditions.push(`source_format = ${bind(filters.sourceFormat)}`);
    if (filters.targetFormat)
      conditions.push(`target_format = ${bind(filters.targetFormat)}`);
    if (filters.status) conditions.push(`status = ${bind(filters.status)}`);
    if (filters.createdAtFrom)
      conditions.push(
        `created_at >= ${bind(filters.createdAtFrom)}::timestamptz`,
      );
    if (filters.createdAtTo)
      conditions.push(`created_at < ${bind(filters.createdAtTo)}::timestamptz`);
    if (position)
      conditions.push(
        `(created_at, id) < (${bind(position.createdAt)}::timestamptz, ${bind(position.id)}::uuid)`,
      );
    const sql = `SELECT ${FIELDS} FROM transformations
                  WHERE ${conditions.join(' AND ')}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ${bind(filters.limit + 1)}`;

    const rows = await this.db.transaction(async (manager) => {
      // Scoped to this transaction's connection, reset at commit or rollback (D51).
      await manager.query(`SET LOCAL statement_timeout = '2s'`);
      return manager.query<Row[]>(sql, params);
    });
    const items = rows.slice(0, filters.limit).map(item);
    audit.count = items.length;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > filters.limit && last
          ? encodeHistoryCursor(
              { createdAt: last.createdAt, id: last.id },
              filters,
            )
          : null,
    };
  }

  private async audited(
    actor: string,
    audit: Audit,
    work: (audit: Audit) => Promise<HistoryPage>,
  ): Promise<HistoryPage> {
    const started = performance.now();
    const done = (result: string, category?: string) => {
      const durationMs = Math.round(performance.now() - started);
      const line = {
        event: 'transformation_history',
        actorUserId: actor,
        ...audit,
        result,
        ...(category ? { category } : {}),
        durationMs,
      };
      if (result === 'success' && durationMs < SLOW_MS)
        this.logger.log(line, 'history read');
      else
        this.logger.warn(
          line,
          result === 'success' ? 'slow history read' : 'history read failed',
        );
    };
    try {
      const page = await work(audit);
      done('success');
      return page;
    } catch (error) {
      done(
        'failure',
        error instanceof AppException
          ? error.code
          : (classifyDbError(error)?.kind ?? 'unknown'),
      );
      throw error;
    }
  }
}

function item(row: Row): TransformationHistoryItem {
  return {
    id: row.id,
    type: row.type,
    sourceFormat: row.source_format,
    targetFormat: row.target_format,
    status: row.status,
    inputSize: Number(row.input_size),
    outputSize: row.output_size === null ? null : Number(row.output_size),
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    // Spec 2.3 §1.3.4: fixed until saving (spec 2.4, C19) adds the storage columns.
    storageStatus: 'not_requested',
    hasStoredFile: false,
    fileExpiresAt: null,
  };
}
