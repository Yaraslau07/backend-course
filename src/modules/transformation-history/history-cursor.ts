import type { HistoryFilters } from './history-query';

/** The last row of a page: `created_at DESC, id DESC` continues after it. */
export interface HistoryPosition {
  createdAt: string;
  id: string;
}

/** Spec 2.3 §1.3.5: version, position and the canonical filter set, as base64url JSON. */
export function encodeHistoryCursor(
  position: HistoryPosition,
  filters: HistoryFilters,
): string {
  void [position, filters];
  throw new Error('not implemented');
}

/** The position, or `400 invalid_cursor` for anything malformed or bound to another set. */
export function decodeHistoryCursor(
  cursor: string,
  filters: HistoryFilters,
): HistoryPosition {
  void [cursor, filters];
  throw new Error('not implemented');
}
