import { randomBytes } from 'node:crypto';

import { AppException } from '@/core/errors/app.exception';

/** 32 lowercase hex characters: an `Idempotency-Key` / `jobId` (spec 1.6 §1.3.2). */
export const JOB_ID = /^[0-9a-f]{32}$/;

/** The `Idempotency-Key` header, or `400 bad_request`. */
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value))
    throw new AppException('bad_request');
  return value;
}

/**
 * The `Deletion-Receipt` header as a job id, or null when it can't be one. The caller answers null
 * with the same 404 as an unknown receipt, so the format check reveals nothing (D57).
 */
export function receiptJobId(value: unknown): string | null {
  return typeof value === 'string' && JOB_ID.test(value) ? value : null;
}

/** The deletion routes that take no body refuse one: `400 bad_request`. */
export function assertNoBody(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): void {
  if (
    body !== undefined ||
    Number(headers['content-length'] ?? 0) > 0 ||
    headers['transfer-encoding'] !== undefined
  )
    throw new AppException('bad_request');
}

/** `deleted.<32 lowercase hex>@example.invalid`, random, never derived from the email (spec 1.6 §1.3.6). */
export function newTombstone(): string {
  return `deleted.${randomBytes(16).toString('hex')}@example.invalid`;
}
