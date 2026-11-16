export type DbErrorClass =
  | { kind: 'unique_violation'; constraint?: string }
  | { kind: 'unavailable'; dbCode: string }
  | { kind: 'other'; dbCode: string };

/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
export function classifyDbError(_error: unknown): DbErrorClass | null {
  throw new Error('not implemented');
}
