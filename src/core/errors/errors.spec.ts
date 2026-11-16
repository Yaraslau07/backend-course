import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { QueryFailedError } from 'typeorm';

import { AppException } from './app.exception';
import { classifyDbError } from './db-errors';
import { ERROR_CATALOGUE, STATUS_TO_CODE } from './error-catalogue';
import { safeStack, toErrorResponse } from './error-response';
import { validationExceptionFactory } from './validation';

/** A QueryFailedError as TypeORM builds it, with the pg driver error inside. */
function queryFailed(
  code: string,
  extra: Record<string, unknown> = {},
): QueryFailedError {
  const driverError = Object.assign(new Error(`pg error ${code}`), {
    code,
    ...extra,
  });
  return new QueryFailedError('SELECT $1', ['parameter-value'], driverError);
}

describe('ERROR_CATALOGUE', () => {
  it('gives every code a 4xx or 5xx status and a message', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOGUE)) {
      expect(code).toMatch(/^[a-z][a-z_]*$/);
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it('contains every code of the catalogue in docs/invariants.md with its status', () => {
    const expected: [string, number][] = [
      ['invalid_credentials', 401],
      ['invalid_session', 401],
      ['permission_denied', 403],
      ['ownership_denied', 403],
      ['csrf_rejected', 403],
      ['self_confirmation_required', 403],
      ['invalid_cursor', 400],
      ['file_not_ready', 409],
      ['authorization_unavailable', 503],
    ];
    for (const [code, status] of expected) {
      expect(ERROR_CATALOGUE).toHaveProperty([code, 'status'], status);
    }
  });
});

describe('AppException', () => {
  it('takes its status and default message from the catalogue', () => {
    const error = new AppException('invalid_session');

    expect(error.getStatus()).toBe(401);
    expect(error.code).toBe('invalid_session');
    expect(error.message).toBe(ERROR_CATALOGUE.invalid_session.message);
    expect(error).toBeInstanceOf(HttpException);
  });

  it('accepts safe extras and an explicit message', () => {
    const error = new AppException(
      'too_many_requests',
      { retryAfterSeconds: 42 },
      'Wait before asking for another code.',
    );

    expect(error.extras).toEqual({ retryAfterSeconds: 42 });
    expect(error.message).toBe('Wait before asking for another code.');
  });
});

describe('classifyDbError()', () => {
  it('reports a unique violation with its constraint name', () => {
    expect(
      classifyDbError(queryFailed('23505', { constraint: 'uq_users_email' })),
    ).toEqual({ kind: 'unique_violation', constraint: 'uq_users_email' });
  });

  it.each([
    ['57014', 'statement timeout or cancel'],
    ['08006', 'connection failure'],
    ['08001', 'cannot connect'],
    ['53300', 'too many connections'],
    ['57P01', 'admin shutdown'],
    ['57P03', 'cannot connect now'],
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock'],
  ])('treats SQLSTATE %s (%s) as the database being unavailable', (code) => {
    expect(classifyDbError(queryFailed(code))).toEqual({
      kind: 'unavailable',
      dbCode: code,
    });
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
  ])('treats a socket error %s as the database being unavailable', (code) => {
    const error = Object.assign(new Error(`connect ${code}`), { code });
    expect(classifyDbError(error)).toEqual({
      kind: 'unavailable',
      dbCode: code,
    });
  });

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
  ])('treats the pg pool error "%s" as unavailable', (message) => {
    expect(classifyDbError(new Error(message))).toEqual({
      kind: 'unavailable',
      dbCode: 'connection',
    });
  });

  it('treats a TypeORM "not connected" error as unavailable', () => {
    const error = new Error('Cannot execute operation');
    error.name = 'CannotExecuteNotConnectedError';
    expect(classifyDbError(error)).toEqual({
      kind: 'unavailable',
      dbCode: 'not_connected',
    });
  });

  it('leaves other database errors and non-database errors alone', () => {
    expect(classifyDbError(queryFailed('22P02'))).toEqual({
      kind: 'other',
      dbCode: '22P02',
    });
    expect(classifyDbError(new Error('boom'))).toBeNull();
    expect(classifyDbError('a string')).toBeNull();
  });
});

describe('toErrorResponse()', () => {
  it('renders an AppException with its extras after the base fields', () => {
    const response = toErrorResponse(
      new AppException('too_many_requests', { retryAfterSeconds: 30 }),
    );

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      statusCode: 429,
      code: 'too_many_requests',
      message: ERROR_CATALOGUE.too_many_requests.message,
      retryAfterSeconds: 30,
    });
    expect(response.headers).toEqual({ 'Retry-After': '30' });
  });

  it('sets Retry-After only for a positive whole number of seconds', () => {
    for (const retryAfterSeconds of [0, -1, 1.5]) {
      const response = toErrorResponse(
        new AppException('service_unavailable', { retryAfterSeconds }),
      );
      expect(response.headers).toEqual({});
    }
  });

  it.each([
    [new BadRequestException('echoes "user input"'), 400, 'bad_request'],
    [new UnauthorizedException('details'), 401, 'invalid_session'],
    [new ForbiddenException('details'), 403, 'forbidden'],
    [new NotFoundException('Cannot GET /x?q=secret'), 404, 'not_found'],
    [new HttpException('x', 429), 429, 'too_many_requests'],
    [new HttpException('x', 409), 409, 'conflict'],
    [new HttpException('x', 405), 405, 'method_not_allowed'],
    [new HttpException('x', 408), 408, 'request_timeout'],
    [new HttpException('x', 413), 413, 'payload_too_large'],
    [new HttpException('x', 422), 422, 'unprocessable_entity'],
    [new HttpException('x', 415), 415, 'unsupported_media_type'],
    [new HttpException('x', 503), 503, 'service_unavailable'],
    [new HttpException('x', 504), 504, 'gateway_timeout'],
  ])(
    'maps a plain %s to status %i and code %s with the catalogue message',
    (exception, status, code) => {
      const response = toErrorResponse(exception);

      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        statusCode: status,
        code,
        message: ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE].message,
      });
    },
  );

  it('turns an unmapped 4xx into a plain 400 bad_request, so a code always means one status', () => {
    const response = toErrorResponse(new HttpException('teapot', 418));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'bad_request',
    });
  });

  it('gives every code in the status map the status of its catalogue entry', () => {
    for (const [status, code] of Object.entries(STATUS_TO_CODE)) {
      expect(ERROR_CATALOGUE[code].status).toBe(Number(status));
    }
  });

  it('turns an unmapped 5xx into internal_error', () => {
    const response = toErrorResponse(new HttpException('x', 502));

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
  });

  it('maps a unique violation to 409 conflict without naming the constraint', () => {
    const response = toErrorResponse(
      queryFailed('23505', { constraint: 'uq_users_email' }),
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: 'conflict',
      message: ERROR_CATALOGUE.conflict.message,
    });
    expect(response.log).toEqual({
      level: 'warn',
      fields: {
        errorType: 'QueryFailedError',
        dbCode: '23505',
        constraint: 'uq_users_email',
      },
    });
  });

  it('maps an unavailable database to 503 service_unavailable', () => {
    const response = toErrorResponse(queryFailed('57014'));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('service_unavailable');
    expect(response.log.level).toBe('error');
    expect(response.log.fields).toMatchObject({ dbCode: '57014' });
  });

  it('hides any other error behind a generic 500 and logs no message or parameters', () => {
    const response = toErrorResponse(queryFailed('22P02'));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'internal_error',
      message: ERROR_CATALOGUE.internal_error.message,
    });
    expect(response.log.level).toBe('error');
    expect(JSON.stringify(response.log.fields)).not.toContain(
      'parameter-value',
    );
    expect(JSON.stringify(response.log.fields)).not.toContain('pg error');
  });

  it('handles values that are not errors', () => {
    for (const thrown of ['a string', null, undefined, 42, { a: 1 }]) {
      const response = toErrorResponse(thrown);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('internal_error');
    }
  });

  it('logs nothing for an ordinary 4xx', () => {
    expect(toErrorResponse(new AppException('not_found')).log.level).toBe(
      'none',
    );
  });
});

describe('safeStack()', () => {
  it('keeps only the frames, never the message', () => {
    const error = new Error('first line with secret\nsecond line with secret');

    const stack = safeStack(error);

    expect(stack).toBeDefined();
    expect(stack).not.toContain('secret');
    expect(stack?.split('\n').every((line) => line.startsWith('at '))).toBe(
      true,
    );
  });

  it('returns undefined when there is no stack', () => {
    expect(safeStack('not an error')).toBeUndefined();
  });
});

describe('validationExceptionFactory()', () => {
  const error = (
    property: string,
    constraints?: Record<string, string>,
    children: ValidationError[] = [],
  ): ValidationError => ({ property, constraints, children, value: 'leak' });

  it('lists the failing fields and rule names, never the messages or values', () => {
    const exception = validationExceptionFactory([
      error('email', { isEmail: 'email must be an email, got "leak"' }),
      error('password', { minLength: 'too short', matches: 'needs a digit' }),
    ]);

    expect(exception).toBeInstanceOf(AppException);
    expect(exception.code).toBe('validation_failed');
    expect(exception.extras).toEqual({
      errors: [
        { field: 'email', rules: ['isEmail'] },
        { field: 'password', rules: ['minLength', 'matches'] },
      ],
    });
    expect(JSON.stringify(exception.extras)).not.toContain('leak');
  });

  it('builds dotted paths for nested objects and arrays', () => {
    const exception = validationExceptionFactory([
      error('address', undefined, [error('city', { isString: 'x' })]),
      error('items', undefined, [
        error('0', undefined, [error('name', { isNotEmpty: 'x' })]),
      ]),
    ]);

    expect(exception.extras.errors).toEqual([
      { field: 'address.city', rules: ['isString'] },
      { field: 'items.0.name', rules: ['isNotEmpty'] },
    ]);
  });

  it('caps the list and the length of attacker-chosen field names', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      error(`field${i}`, { whitelistValidation: 'x' }),
    );
    const long = error('x'.repeat(500), { whitelistValidation: 'x' });

    const errors =
      validationExceptionFactory([long, ...many]).extras.errors ?? [];

    expect(errors).toHaveLength(50);
    expect(errors[0].field).toHaveLength(100);
  });
});
