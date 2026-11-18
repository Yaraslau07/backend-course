import { AppException } from '@/core/errors/app.exception';

/** 32 lowercase hex characters: an `Idempotency-Key` / `jobId` (spec 1.6 §1.3.2). */
export const JOB_ID = /^[0-9a-f]{32}$/;

/** The `Idempotency-Key` header, or `400 bad_request`. */
export function idempotencyKey(value: unknown): string {
  void value;
  throw new Error('not implemented');
}

/** The `Deletion-Receipt` header as a job id, or null when it can't be one (answered as 404). */
export function receiptJobId(value: unknown): string | null {
  void value;
  throw new Error('not implemented');
}

/** The deletion routes that take no body refuse one: `400 bad_request`. */
export function assertNoBody(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): void {
  void body;
  void headers;
  throw new AppException('internal_error');
}

/** `deleted.<32 lowercase hex>@example.invalid`, random, never derived from the email. */
export function newTombstone(): string {
  throw new Error('not implemented');
}
