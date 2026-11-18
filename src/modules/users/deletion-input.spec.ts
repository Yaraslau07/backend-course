import { AppException } from '@/core/errors/app.exception';

import {
  assertNoBody,
  idempotencyKey,
  newTombstone,
  receiptJobId,
} from './deletion-input';

const KEY = '0123456789abcdef0123456789abcdef';
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return undefined;
};

describe('idempotencyKey() (spec 1.6 §1.3.2)', () => {
  it('accepts exactly 32 lowercase hex characters', () => {
    expect(idempotencyKey(KEY)).toBe(KEY);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['uppercase', KEY.toUpperCase()],
    ['31 characters', KEY.slice(1)],
    ['33 characters', `${KEY}0`],
    ['not hex', `${KEY.slice(1)}g`],
    ['a uuid', '01234567-89ab-cdef-0123-456789abcdef'],
    ['repeated header', [KEY, KEY]],
    ['padded', ` ${KEY}`],
  ])('refuses %s with 400 bad_request', (_name, value) => {
    expect(code(() => idempotencyKey(value))).toBe('bad_request');
  });
});

describe('receiptJobId() (spec 1.6 §1.3.4)', () => {
  it('returns a well-formed receipt', () => {
    expect(receiptJobId(KEY)).toBe(KEY);
  });

  it.each([undefined, '', KEY.toUpperCase(), 'nope', [KEY]])(
    'returns null for %p, so the answer is the same 404 as an unknown receipt',
    (value) => {
      expect(receiptJobId(value)).toBeNull();
    },
  );
});

describe('assertNoBody()', () => {
  it('passes a request without a body', () => {
    expect(code(() => assertNoBody(undefined, {}))).toBeUndefined();
    expect(
      code(() => assertNoBody(undefined, { 'content-length': '0' })),
    ).toBeUndefined();
  });

  it.each([
    ['a parsed body', {}, {}],
    ['a content length', undefined, { 'content-length': '2' }],
    ['chunked transfer', undefined, { 'transfer-encoding': 'chunked' }],
  ])('refuses %s with 400', (_name, body, headers) => {
    expect(code(() => assertNoBody(body, headers))).toBe('bad_request');
  });
});

describe('newTombstone() (spec 1.6 §1.3.6)', () => {
  it('is deleted.<32 hex>@example.invalid and different every time', () => {
    const a = newTombstone();
    const b = newTombstone();
    expect(a).toMatch(/^deleted\.[0-9a-f]{32}@example\.invalid$/);
    expect(a).not.toBe(b);
  });
});
