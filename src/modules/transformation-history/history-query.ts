import type {
  TransformationStatus,
  TransformationType,
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

export function parseHistoryQuery(
  raw: unknown,
  formats: KnownFormats,
): HistoryQuery {
  void [raw, formats];
  throw new Error('not implemented');
}
