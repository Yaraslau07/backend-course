import { HttpException } from '@nestjs/common';

import type { ErrorCode } from './error-catalogue';

export interface FieldError {
  field: string;
  rules: string[];
}

export interface ErrorExtras {
  retryAfterSeconds?: number;
  attemptId?: string;
  errors?: FieldError[];
}

// Stub: filled in by the implementation commit.
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly extras: ErrorExtras = {},
    message?: string,
  ) {
    super(message ?? 'not implemented', 500);
  }
}
