import { AppException } from '@/core/errors/app.exception';

import { decodeHistoryCursor, encodeHistoryCursor } from './history-cursor';
import type { HistoryFilters } from './history-query';

const filters: HistoryFilters = {
  limit: 20,
  type: 'file',
  sourceFormat: null,
  targetFormat: 'json',
  status: null,
  createdAtFrom: '2026-11-01T00:00:00.000Z',
  createdAtTo: null,
};
const position = {
  createdAt: '2026-11-10T12:00:00.123Z',
  id: '0b6e3f5a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
};
const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};

describe('history cursor (spec 2.3 §1.3.5)', () => {
  it('round-trips the position for the same filter set', () => {
    const cursor = encodeHistoryCursor(position, filters);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHistoryCursor(cursor, filters)).toEqual(position);
  });

  it('carries the version, position and every filter, missing ones as null', () => {
    const decoded = JSON.parse(
      Buffer.from(
        encodeHistoryCursor(position, filters),
        'base64url',
      ).toString(),
    ) as Record<string, unknown>;
    expect(decoded).toEqual({
      v: 1,
      createdAt: position.createdAt,
      id: position.id,
      filters,
    });
  });

  it.each([
    ['a different limit', { limit: 50 }],
    ['a different type', { type: 'image' as const }],
    ['a filter added', { status: 'success' as const }],
    ['a filter removed', { targetFormat: null }],
    ['a different period', { createdAtFrom: '2026-11-01T00:00:00.001Z' }],
  ])('is refused for %s (400 invalid_cursor)', (_name, change) => {
    const cursor = encodeHistoryCursor(position, filters);
    expect(
      codeOf(() => decodeHistoryCursor(cursor, { ...filters, ...change })),
    ).toBe('invalid_cursor');
  });

  it.each([
    ['not base64url', '!!!'],
    ['padded base64', `${json({ v: 1 })}=`],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an array', json([1])],
    [
      'another version',
      json({ v: 2, createdAt: position.createdAt, id: position.id, filters }),
    ],
    ['a missing field', json({ v: 1, createdAt: position.createdAt, filters })],
    [
      'an extra field',
      json({
        v: 1,
        createdAt: position.createdAt,
        id: position.id,
        filters,
        x: 1,
      }),
    ],
    [
      'a time without milliseconds',
      json({
        v: 1,
        createdAt: '2026-11-10T12:00:00Z',
        id: position.id,
        filters,
      }),
    ],
    [
      'an impossible time',
      json({
        v: 1,
        createdAt: '2026-13-10T12:00:00.000Z',
        id: position.id,
        filters,
      }),
    ],
    [
      'an id that is not a uuid',
      json({ v: 1, createdAt: position.createdAt, id: 'abc', filters }),
    ],
    [
      'an uppercase id',
      json({
        v: 1,
        createdAt: position.createdAt,
        id: position.id.toUpperCase(),
        filters,
      }),
    ],
    [
      'filters with an extra key',
      json({ v: 1, ...position, filters: { ...filters, x: 1 } }),
    ],
  ])('refuses %s (400 invalid_cursor)', (_name, cursor) => {
    expect(codeOf(() => decodeHistoryCursor(cursor, filters))).toBe(
      'invalid_cursor',
    );
  });
});
