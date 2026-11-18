import { AppException } from '@/core/errors/app.exception';

import type { HistoryFilters } from './history-query';

/** The last row of a page: `created_at DESC, id DESC` continues after it. */
export interface HistoryPosition {
  createdAt: string;
  id: string;
}

const VERSION = 1;
const FILTER_KEYS: (keyof HistoryFilters)[] = [
  'limit',
  'type',
  'sourceFormat',
  'targetFormat',
  'status',
  'createdAtFrom',
  'createdAtTo',
];
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const invalid = (): never => {
  throw new AppException('invalid_cursor');
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** Fixed key order, so the same position and set always encode to the same text. */
function canonical(filters: HistoryFilters): HistoryFilters {
  return Object.fromEntries(
    FILTER_KEYS.map((key) => [key, filters[key]]),
  ) as unknown as HistoryFilters;
}

/**
 * Spec 2.3 §1.3.5: version, position and the canonical filter set (missing filters as `null`),
 * as base64url JSON. Not signed: the spec doesn't ask for it, and a crafted position only
 * positions a page of a history the caller is already allowed to read (D76).
 */
export function encodeHistoryCursor(
  position: HistoryPosition,
  filters: HistoryFilters,
): string {
  return Buffer.from(
    JSON.stringify({
      v: VERSION,
      createdAt: position.createdAt,
      id: position.id,
      filters: canonical(filters),
    }),
  ).toString('base64url');
}

/**
 * The position, or `400 invalid_cursor`: canonical base64url, the exact shape, this version, a
 * millisecond UTC time, a lowercase uuid, and the same filter set as the current query.
 */
export function decodeHistoryCursor(
  cursor: string,
  filters: HistoryFilters,
): HistoryPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid();
  }
  if (!isObject(value) || !sameKeys(value, ['v', 'createdAt', 'id', 'filters']))
    invalid();
  const decoded = value as Record<string, unknown>;
  if (decoded.v !== VERSION) invalid();
  const { createdAt, id } = decoded;
  if (
    typeof createdAt !== 'string' ||
    !ISO_MS.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  )
    invalid();
  if (typeof id !== 'string' || !UUID.test(id)) invalid();
  const bound = decoded.filters;
  if (!isObject(bound) || !sameKeys(bound, FILTER_KEYS)) invalid();
  const current = canonical(filters);
  for (const key of FILTER_KEYS)
    if ((bound as Record<string, unknown>)[key] !== current[key]) invalid();
  return { createdAt: createdAt as string, id: id as string };
}
