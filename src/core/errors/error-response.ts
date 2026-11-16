import { HttpException } from '@nestjs/common';

import { AppException } from './app.exception';
import { classifyDbError } from './db-errors';
import {
  ERROR_CATALOGUE,
  type ErrorCode,
  STATUS_TO_CODE,
} from './error-catalogue';

export interface ErrorResponse {
  status: number;
  /** Everything except `requestId`, which the filter adds. */
  body: { statusCode: number; code: ErrorCode; message: string } & Record<
    string,
    unknown
  >;
  headers: Record<string, string>;
  log: { level: 'none' | 'warn' | 'error'; fields: Record<string, unknown> };
}

/**
 * The stack frames only. The first line of a stack is the message, and messages can carry values:
 * Postgres quotes the offending input (`invalid input value for enum …: "…"`), libraries echo arguments.
 */
export function safeStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return undefined;
  }
  return error.stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .join('\n');
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name;
  return error === null ? 'null' : typeof error;
}

function build(
  code: ErrorCode,
  status: number = ERROR_CATALOGUE[code].status,
  extras: Record<string, unknown> = {},
): Pick<ErrorResponse, 'status' | 'body' | 'headers'> {
  const headers: Record<string, string> = {};
  const retryAfter = extras.retryAfterSeconds;
  if (
    typeof retryAfter === 'number' &&
    Number.isInteger(retryAfter) &&
    retryAfter > 0
  ) {
    headers['Retry-After'] = String(retryAfter);
  }
  return {
    status,
    // Extras first, so they can never overwrite the base fields.
    body: {
      ...extras,
      statusCode: status,
      code,
      message: ERROR_CATALOGUE[code].message,
    },
    headers,
  };
}

/**
 * Turns anything thrown during a request into the envelope (minus requestId), the headers to set,
 * and what to log. Pure, so every branch is unit-tested.
 */
export function toErrorResponse(exception: unknown): ErrorResponse {
  // 1. Our own errors: the code decides the status; the message may be specific.
  if (exception instanceof AppException) {
    const response = build(exception.code, undefined, { ...exception.extras });
    response.body.message = exception.message;
    const level = response.status >= 500 ? 'error' : 'none';
    return {
      ...response,
      log: { level, fields: { errorType: 'AppException' } },
    };
  }

  // 2. Nest's and libraries' HttpExceptions: status kept, message replaced (it can echo the request).
  //    Fastify's own errors (body too large, unsupported content type) arrive here too: Nest wraps
  //    any error with a `statusCode` into an HttpException before the filter sees it.
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status >= 500) {
      const code = STATUS_TO_CODE[status] ?? 'internal_error';
      return {
        ...build(code, ERROR_CATALOGUE[code].status),
        log: { level: 'error', fields: { errorType: exception.name } },
      };
    }
    // Any other 4xx becomes a plain 400, so a code always means one status (D37).
    const code = STATUS_TO_CODE[status] ?? 'bad_request';
    return { ...build(code), log: { level: 'none', fields: {} } };
  }

  // 3. Database errors.
  const db = classifyDbError(exception);
  if (db?.kind === 'unique_violation') {
    // Normally a feature catches this and answers with its own code; this is the safety net.
    return {
      ...build('conflict'),
      log: {
        level: 'warn',
        fields: {
          errorType: errorType(exception),
          dbCode: '23505',
          constraint: db.constraint,
        },
      },
    };
  }
  if (db?.kind === 'unavailable') {
    return {
      ...build('service_unavailable'),
      log: {
        level: 'error',
        fields: { errorType: errorType(exception), dbCode: db.dbCode },
      },
    };
  }

  // 4. Anything else is a bug: a generic 500, logged with frames but no message.
  return {
    ...build('internal_error'),
    log: {
      level: 'error',
      fields: {
        errorType: errorType(exception),
        dbCode: db?.dbCode,
        stack: safeStack(exception),
      },
    },
  };
}
