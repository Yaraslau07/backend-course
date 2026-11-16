import { HttpException } from '@nestjs/common';

import { ERROR_CATALOGUE, type ErrorCode } from './error-catalogue';

export interface FieldError {
  field: string;
  rules: string[];
}

/**
 * Extra fields a spec allows in an error body. Only these keys exist, so nothing else
 * can be attached by accident. Add a key here when a spec asks for it.
 */
export interface ErrorExtras {
  /** Also sent as the Retry-After header. */
  retryAfterSeconds?: number;
  /** Email challenges: the 503 after SMTP fails keeps these (specs 1.0, 1.2, 1.5, 1.6). */
  confirmationRequired?: boolean;
  method?: 'otp' | 'magic_link';
  attemptId?: string;
  challengeId?: string;
  /** Request validation: field paths and rule names, never values or messages. */
  errors?: FieldError[];
}

/**
 * The error to throw from application code: `throw new AppException('permission_denied')`.
 * The status comes from the code, so a code always means the same status.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly extras: ErrorExtras = {},
    message: string = ERROR_CATALOGUE[code].message,
  ) {
    super(message, ERROR_CATALOGUE[code].status);
  }
}
