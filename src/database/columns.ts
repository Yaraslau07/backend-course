import type { ColumnOptions } from 'typeorm';

/**
 * The one definition of a timestamp column (D12): `timestamptz(3)`, so a value survives the trip
 * through a JS Date unchanged. Use these instead of spelling the options out, and never
 * `@CreateDateColumn` / `@UpdateDateColumn`.
 */
export function timestamp(
  name: string,
  extra: Pick<ColumnOptions, 'nullable'> = {},
): ColumnOptions {
  return { name, type: 'timestamptz', precision: 3, ...extra };
}

/** A timestamp filled from the database clock when the row is inserted. */
export function timestampNow(
  name: string,
  extra: Pick<ColumnOptions, 'nullable'> = {},
): ColumnOptions {
  return { ...timestamp(name, extra), default: () => 'now()' };
}
