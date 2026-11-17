import { PassThrough, type Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { Ownership } from '@/core/authorization/ownership';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';

import { safeProfile, type SafeProfile, type ProfileRow } from './safe-profile';
import { UserListCursor } from './user-list-cursor.service';
import { parseUserListQuery, validateUserId } from './user-list-query';

const PROFILE_FIELDS =
  'id, email, display_name, photo_key, status, created_at, updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (id: string) =>
  id.length === 36 && UUID.test(id) ? id : null;
// Operational warning below the contract's hard two-second SQL timeout; no query values.
const SLOW_LIST_MS = 500;

@Injectable()
export class UsersReadService {
  private readonly logger = new Logger('UsersRead');
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly ownership: Ownership,
    private readonly limiter: RateLimiter,
    private readonly storage: ObjectStorage,
    private readonly cursors: UserListCursor,
  ) {}

  async profile(actor: string, target: string): Promise<SafeProfile> {
    return this.read(actor, target, 'profile', async () => {
      const [row] = await this.db.query<ProfileRow[]>(
        `SELECT ${PROFILE_FIELDS} FROM users WHERE id = $1`,
        [uuidOrNull(target)],
      );
      if (!row) throw new AppException('not_found');
      return safeProfile(row, this.config.get('PUBLIC_API_BASE_URL'));
    });
  }

  async photo(actor: string, target: string): Promise<Readable> {
    return this.read(actor, target, 'photo', async () => {
      const [row] = await this.db.query<
        Pick<ProfileRow, 'id' | 'status' | 'photo_key'>[]
      >(`SELECT id, status, photo_key FROM users WHERE id = $1`, [
        uuidOrNull(target),
      ]);
      if (
        !row ||
        !row.photo_key ||
        row.status === 'deleting' ||
        row.status === 'deleted'
      )
        throw new AppException('not_found');
      const object = await this.storage.read(row.photo_key);
      if (object.kind !== 'found') {
        this.logger.error(
          {
            event: 'photo_storage',
            category:
              object.kind === 'not_found' ? 'photo_inconsistent' : 'storage',
            actorUserId: actor,
            targetUserId: row.id,
          },
          'photo storage unavailable',
        );
        throw new AppException('service_unavailable');
      }
      // A late stream failure cannot become a JSON response after bytes were sent. Log a safe
      // category and replace the transport error before Fastify's stream handler sees it.
      const output = new PassThrough();
      output.on('error', () => undefined);
      output.once('close', () => object.stream.destroy());
      object.stream.once('error', () => {
        this.logger.error(
          {
            event: 'photo_storage',
            category: 'storage_stream',
            actorUserId: actor,
            targetUserId: row.id,
          },
          'photo stream failed',
        );
        output.destroy(new AppException('service_unavailable'));
      });
      object.stream.pipe(output);
      return output;
    });
  }

  async list(
    actor: string,
    raw: unknown,
  ): Promise<{ items: SafeProfile[]; nextCursor: string | null }> {
    const started = performance.now();
    const query = parseUserListQuery(raw);
    try {
      const cursor = query.cursor
        ? this.cursors.decode(query.cursor, query)
        : undefined;
      const { rows, snapshotAt } = await this.db.transaction(
        async (manager) => {
          // SET LOCAL is scoped to this transaction/connection, including after a cancellation.
          await manager.query(`SET LOCAL statement_timeout = '2s'`);
          const snapshotAt =
            cursor?.snapshotAt ??
            (
              await manager.query<{ snapshot_at: Date }[]>(
                `SELECT date_trunc('milliseconds', clock_timestamp()) AS snapshot_at`,
              )
            )[0].snapshot_at.toISOString();
          const params: unknown[] = [snapshotAt];
          const bind = (value: unknown) => {
            params.push(value);
            return `$${params.length}`;
          };
          const conditions = ['created_at < $1::timestamptz'];
          if (query.status) conditions.push(`status = ${bind(query.status)}`);
          if (query.searchBy === 'id')
            conditions.push(`id = ${bind(uuidOrNull(query.q!))}::uuid`);
          if (query.searchBy === 'email' || query.searchBy === 'displayName') {
            const column =
              query.searchBy === 'email'
                ? 'email'
                : 'lower(normalize(display_name, NFC))';
            const prefix = query.q!.replace(/[\\%_]/g, '\\$&');
            const placeholder = bind(`${prefix}%`);
            // Lower the query in Postgres too, so Unicode casing uses the same DB collation.
            conditions.push(
              `${column} LIKE ${query.searchBy === 'displayName' ? `lower(${placeholder}::text)` : placeholder} ESCAPE '\\'`,
            );
          }
          const columns =
            query.sort === 'createdAt'
              ? ['created_at', 'id']
              : ['id', 'created_at'];
          const types =
            query.sort === 'createdAt'
              ? ['timestamptz', 'uuid']
              : ['uuid', 'timestamptz'];
          if (cursor)
            conditions.push(
              `(${columns.join(', ')}) ${query.order === 'asc' ? '>' : '<'} (${bind(cursor.lastSortValue)}::${types[0]}, ${bind(cursor.lastTieBreaker)}::${types[1]})`,
            );
          const direction = query.order === 'asc' ? 'ASC' : 'DESC';
          const rows = await manager.query<ProfileRow[]>(
            `SELECT ${PROFILE_FIELDS} FROM users WHERE ${conditions.join(' AND ')} ORDER BY ${columns.map((c) => `${c} ${direction}`).join(', ')} LIMIT ${bind(query.limit + 1)}`,
            params,
          );
          return { rows, snapshotAt };
        },
      );
      const hasNext = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const result = {
        items: page.map((row) =>
          safeProfile(row, this.config.get('PUBLIC_API_BASE_URL')),
        ),
        nextCursor: hasNext
          ? this.cursors.encode(
              query,
              page[page.length - 1],
              cursor ?? snapshotAt,
            )
          : null,
      };
      this.logger.log(
        {
          event: 'users_list',
          actorUserId: actor,
          result: 'success',
          searchBy: query.searchBy ?? null,
          hasStatus: !!query.status,
          sort: query.sort,
          order: query.order,
          limit: query.limit,
          pageSize: page.length,
          hasNext,
          durationMs: performance.now() - started,
        },
        'user list read',
      );
      if (performance.now() - started >= SLOW_LIST_MS) {
        this.logger.warn(
          {
            event: 'users_list_slow',
            actorUserId: actor,
            category: 'slow_query',
            durationMs: performance.now() - started,
          },
          'user list exceeded monitoring threshold',
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        {
          event: 'users_list',
          actorUserId: actor,
          category: error instanceof AppException ? error.code : 'database',
          result: 'failed',
          durationMs: performance.now() - started,
        },
        'user list failed',
      );
      throw error;
    }
  }

  private async read<T>(
    actor: string,
    target: string,
    operation: 'profile' | 'photo',
    action: () => Promise<T>,
  ): Promise<T> {
    validateUserId(target);
    const started = performance.now();
    const scope =
      actor.toLowerCase() === target.toLowerCase() ? 'self' : 'foreign';
    await this.limiter.enforce(
      scope === 'self' ? 'profile_read_self' : 'profile_read_foreign',
      [actor],
    );
    await this.ownership.selfOr(
      actor,
      target,
      'users',
      'read_any',
      `UsersRead.${operation}`,
    );
    try {
      const result = await action();
      this.logger.log(
        {
          event: 'profile_read',
          operation,
          actorUserId: actor,
          targetUserId: target,
          scope,
          result: 'success',
          durationMs: performance.now() - started,
        },
        'user resource read',
      );
      return result;
    } catch (error) {
      this.logger.warn(
        {
          event: 'profile_read',
          operation,
          actorUserId: actor,
          targetUserId: target,
          scope,
          result: 'failed',
          category: error instanceof AppException ? error.code : 'users',
          durationMs: performance.now() - started,
        },
        'user resource read failed',
      );
      if (classifyDbError(error)?.kind === 'unavailable')
        throw new AppException('service_unavailable');
      throw error;
    }
  }
}
