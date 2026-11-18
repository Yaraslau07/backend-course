import { AppException } from '@/core/errors/app.exception';

import { parseHistoryQuery } from './history-query';

const formats = {
  sources: new Set(['csv', 'json', 'png', 'svg']),
  targets: new Set(['csv', 'json', 'png']),
};
const parse = (raw: unknown) => parseHistoryQuery(raw, formats);
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};
const EMPTY = {
  limit: 20,
  type: null,
  sourceFormat: null,
  targetFormat: null,
  status: null,
  createdAtFrom: null,
  createdAtTo: null,
};

describe('parseHistoryQuery() (spec 2.3 §1.3.1)', () => {
  it('defaults to 20 with every filter explicitly null', () => {
    expect(parse({})).toEqual({ filters: EMPTY });
  });

  it('accepts every filter and normalises the period to UTC milliseconds', () => {
    expect(
      parse({
        limit: '100',
        type: 'image',
        sourceFormat: 'svg',
        targetFormat: 'png',
        status: 'error',
        createdAtFrom: '2026-11-01T10:00:00+02:00',
        createdAtTo: '2026-11-02T00:00:00.5Z',
        cursor: 'abc',
      }),
    ).toEqual({
      filters: {
        limit: 100,
        type: 'image',
        sourceFormat: 'svg',
        targetFormat: 'png',
        status: 'error',
        createdAtFrom: '2026-11-01T08:00:00.000Z',
        createdAtTo: '2026-11-02T00:00:00.500Z',
      },
      cursor: 'abc',
    });
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['a fractional limit', { limit: '1.5' }],
    ['a signed limit', { limit: '+5' }],
    ['an unknown type', { type: 'audio' }],
    ['an unknown source format', { sourceFormat: 'gif' }],
    ['a source that is only a target', { sourceFormat: 'xml' }],
    ['a target that is only a source', { targetFormat: 'svg' }],
    ['an uppercase format', { sourceFormat: 'CSV' }],
    ['an unknown status', { status: 'pending' }],
    ['a date without a time', { createdAtFrom: '2026-11-01' }],
    ['a time without a zone', { createdAtFrom: '2026-11-01T10:00:00' }],
    ['an impossible date', { createdAtFrom: '2026-02-30T00:00:00Z' }],
    [
      'a period that ends before it starts',
      {
        createdAtFrom: '2026-11-02T00:00:00Z',
        createdAtTo: '2026-11-01T00:00:00Z',
      },
    ],
    [
      'an empty period',
      {
        createdAtFrom: '2026-11-01T00:00:00Z',
        createdAtTo: '2026-11-01T00:00:00Z',
      },
    ],
    ['an unknown parameter', { sort: 'asc' }],
    ['a repeated parameter', { type: ['file', 'image'] }],
    ['an empty value', { type: '' }],
  ])('refuses %s with 400', (_name, raw) => {
    expect(codeOf(() => parse(raw))).toBe('bad_request');
  });

  it('a cursor that is empty or absurdly long is invalid_cursor', () => {
    expect(codeOf(() => parse({ cursor: '' }))).toBe('invalid_cursor');
    expect(codeOf(() => parse({ cursor: 'x'.repeat(2049) }))).toBe(
      'invalid_cursor',
    );
  });

  it('refuses a query that is not an object', () => {
    expect(codeOf(() => parse(null))).toBe('bad_request');
  });
});
