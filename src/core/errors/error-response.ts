import type { ErrorCode } from './error-catalogue';

export interface ErrorResponse {
  status: number;
  body: { statusCode: number; code: ErrorCode; message: string } & Record<
    string,
    unknown
  >;
  headers: Record<string, string>;
  log: { level: 'none' | 'warn' | 'error'; fields: Record<string, unknown> };
}

/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
export function toErrorResponse(_exception: unknown): ErrorResponse {
  throw new Error('not implemented');
}

export function safeStack(_error: unknown): string | undefined {
  throw new Error('not implemented');
}
