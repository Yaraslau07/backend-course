import { AppException } from '@/core/errors/app.exception';
import {
  TRANSFORMATION_STATUSES,
  TRANSFORMATION_TYPES,
  type TransformationStatus,
  type TransformationType,
} from '@/modules/transformations/transformation.types';

/** Spec 2.3 §1.3.1: the canonical filter set a cursor is bound to; a missing filter is `null`. */
export interface HistoryFilters {
  limit: number;
  type: TransformationType | null;
  sourceFormat: string | null;
  targetFormat: string | null;
  status: TransformationStatus | null;
  /** Inclusive, normalised to UTC with milliseconds. */
  createdAtFrom: string | null;
  /** Exclusive, normalised to UTC with milliseconds. */
  createdAtTo: string | null;
}

export interface HistoryQuery {
  filters: HistoryFilters;
  cursor?: string;
}

/** The formats a filter may name: every registered source, every registered target. */
export interface KnownFormats {
  sources: ReadonlySet<string>;
  targets: ReadonlySet<string>;
}

const PARAMETERS = new Set([
  'cursor',
  'limit',
  'type',
  'sourceFormat',
  'targetFormat',
  'status',
  'createdAtFrom',
  'createdAtTo',
]);
const MAX_CURSOR = 2048;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const bad = (): never => {
  throw new AppException('bad_request');
};

/** An RFC 3339 date-time with an explicit zone, as UTC milliseconds (spec 2.3: "UTC boundary"). */
function dateTime(value: string): string {
  const match = DATE_TIME.exec(value);
  if (!match) return bad();
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    bad();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : bad();
}

/**
 * Spec 2.3 §1.3.1. Like the user list (D51): unknown or repeated parameters are 400, values are
 * exact (no case folding), and validation runs after the route's permission, in the handler.
 */
export function parseHistoryQuery(
  raw: unknown,
  formats: KnownFormats,
): HistoryQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const input = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(input))
    if (!PARAMETERS.has(key) || typeof value !== 'string') bad();
  const get = (key: string) => input[key] as string | undefined;
  const filled = (key: string) => {
    const value = get(key);
    if (value === '') bad();
    return value;
  };

  const limitText = filled('limit') ?? '20';
  if (!/^[0-9]{1,3}$/.test(limitText)) bad();
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) bad();

  const type = filled('type') ?? null;
  if (
    type !== null &&
    !(TRANSFORMATION_TYPES as readonly string[]).includes(type)
  )
    bad();
  const status = filled('status') ?? null;
  if (
    status !== null &&
    !(TRANSFORMATION_STATUSES as readonly string[]).includes(status)
  )
    bad();
  const sourceFormat = filled('sourceFormat') ?? null;
  if (sourceFormat !== null && !formats.sources.has(sourceFormat)) bad();
  const targetFormat = filled('targetFormat') ?? null;
  if (targetFormat !== null && !formats.targets.has(targetFormat)) bad();

  const from = filled('createdAtFrom');
  const to = filled('createdAtTo');
  const createdAtFrom = from === undefined ? null : dateTime(from);
  const createdAtTo = to === undefined ? null : dateTime(to);
  if (
    createdAtFrom !== null &&
    createdAtTo !== null &&
    createdAtFrom >= createdAtTo
  )
    bad();

  const query: HistoryQuery = {
    filters: {
      limit,
      type: type as TransformationType | null,
      sourceFormat,
      targetFormat,
      status: status as TransformationStatus | null,
      createdAtFrom,
      createdAtTo,
    },
  };
  const cursor = get('cursor');
  if (cursor !== undefined) {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR)
      throw new AppException('invalid_cursor');
    query.cursor = cursor;
  }
  return query;
}
