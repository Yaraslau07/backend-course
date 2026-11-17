import { createHmac, randomBytes } from 'node:crypto';

import { ConfigService } from '@/core/config/config.service';

import { safeProfile, type ProfileRow } from './safe-profile';
import { UserListCursor, type ListCursor } from './user-list-cursor.service';
import { parseUserListQuery, validateUserId } from './user-list-query';
import { USER_STATUSES } from './users.types';

const row: ProfileRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'profile@example.com',
  display_name: 'Saved Name',
  photo_key: 'private-key',
  status: 'active',
  created_at: new Date('2026-11-01T00:00:00.123Z'),
  updated_at: new Date('2026-11-02T00:00:00.456Z'),
};

describe('canonical safe profile', () => {
  it.each(USER_STATUSES)('projects exactly seven fields for %s', (status) => {
    expect(safeProfile({ ...row, status }, 'https://api.example.com/')).toEqual(
      {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        photoUrl: ['deleting', 'deleted'].includes(status)
          ? null
          : `https://api.example.com/users/${row.id}/photo`,
        status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    );
  });

  it('returns nulls without a name or photo and never copies extra fields', () => {
    const privateRow = {
      ...row,
      display_name: null,
      photo_key: null,
      password_hash: 'secret',
    };
    const result = safeProfile(privateRow, 'http://localhost:3007');
    expect(result.displayName).toBeNull();
    expect(result.photoUrl).toBeNull();
    expect(Object.keys(result)).toHaveLength(7);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('list query whitelist and normalization', () => {
  it('uses the fixed defaults', () => {
    expect(parseUserListQuery({})).toEqual({
      limit: 20,
      sort: 'createdAt',
      order: 'desc',
    });
  });

  it.each([
    { extra: 'x' },
    { limit: ['1', '2'] },
    { cursor: ['a', 'b'] },
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: '1e1' },
    { limit: '' },
    { sort: 'email' },
    { order: 'DESC' },
    { status: 'unknown' },
    { searchBy: 'email' },
    { q: 'abc' },
    { searchBy: 'email', q: 'ab' },
    { searchBy: 'email', q: 'a b' },
    { searchBy: 'email', q: 'éabc' },
    { searchBy: 'displayName', q: 'ab\u0000' },
    { searchBy: 'displayName', q: 'a'.repeat(81) },
    { searchBy: 'id', q: 'a/b' },
    { searchBy: 'id', q: 'a'.repeat(129) },
    { searchBy: 'id', q: ' abc ' },
    { cursor: '' },
    null,
    [],
  ])('rejects invalid query %j', (raw) => {
    expect(() => parseUserListQuery(raw)).toThrow();
  });

  it.each(USER_STATUSES)(
    'accepts status %s and both sort fields/directions',
    (status) => {
      for (const sort of ['id', 'createdAt']) {
        for (const order of ['asc', 'desc']) {
          expect(
            parseUserListQuery({ status, sort, order, limit: '100' }),
          ).toEqual({ status, sort, order, limit: 100 });
        }
      }
    },
  );

  it('normalizes email but preserves literal SQL wildcard characters', () => {
    expect(parseUserListQuery({ searchBy: 'email', q: '  AB_%  ' }).q).toBe(
      'ab_%',
    );
  });

  it('normalizes names to NFC and counts Unicode code points', () => {
    expect(
      parseUserListQuery({ searchBy: 'displayName', q: '  E\u0301va  ' }).q,
    ).toBe('Éva');
    expect(
      parseUserListQuery({ searchBy: 'displayName', q: '😀'.repeat(80) }).q,
    ).toHaveLength(160);
  });

  it('accepts the full ID contract without requiring a UUID', () => {
    expect(validateUserId('user_ID-123')).toBe('user_ID-123');
    for (const id of ['', 'with space', 'a/b', 'é', 'a'.repeat(129)]) {
      expect(() => validateUserId(id)).toThrow();
    }
  });
});

describe('signed user list cursor', () => {
  const oldKey = randomBytes(32).toString('base64url');
  const newKey = randomBytes(32).toString('base64url');
  let active: string;
  let ring: { kid: string; key: string }[];
  let cursors: UserListCursor;
  const query = { limit: 20, sort: 'createdAt', order: 'desc' } as const;
  const now = new Date('2026-11-17T12:00:00.000Z');
  const snapshot = new Date(now.getTime() - 1).toISOString();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    active = 'old';
    ring = [{ kid: 'old', key: oldKey }];
    cursors = new UserListCursor({
      get: (key: string) =>
        key === 'USER_LIST_CURSOR_ACTIVE_KEY_ID' ? active : ring,
    } as ConfigService);
  });
  afterEach(() => jest.useRealTimers());

  const resign = (token: string, changes: Record<string, unknown>) => {
    const original = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString(),
    ) as ListCursor;
    const payload = Buffer.from(
      JSON.stringify({ ...original, ...changes }),
    ).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(oldKey, 'base64url'))
      .update(`users-list-cursor:${payload}`)
      .digest('base64url');
    return `${payload}.${signature}`;
  };

  it.each(['createdAt', 'id'] as const)(
    'round trips %s and uses only immutable cursor values',
    (sort) => {
      const q = {
        ...query,
        sort,
        searchBy: 'email' as const,
        q: 'secret@example.com',
      };
      const token = cursors.encode(q, row, snapshot);
      const payload = cursors.decode(token, q);
      expect(payload).toMatchObject({
        v: 1,
        kid: 'old',
        sort,
        order: 'desc',
        snapshotAt: snapshot,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 900000).toISOString(),
      });
      expect(payload.lastSortValue).toBe(
        sort === 'id' ? row.id : row.created_at.toISOString(),
      );
      expect(payload.lastTieBreaker).toBe(
        sort === 'id' ? row.created_at.toISOString() : row.id,
      );
      expect(JSON.stringify(payload)).not.toContain(q.q);
      expect(JSON.stringify(payload)).not.toContain(row.email);
    },
  );

  it('does not extend the first page lifetime and accepts a retained key after rotation', () => {
    const token = cursors.encode(query, row, snapshot);
    active = 'new';
    ring.push({ kid: 'new', key: newKey });
    jest.setSystemTime(now.getTime() + 600000);
    const decoded = cursors.decode(token, query);
    const next = cursors.decode(cursors.encode(query, row, decoded), query);
    expect(next.kid).toBe('new');
    expect(next.issuedAt).toBe(decoded.issuedAt);
    expect(next.expiresAt).toBe(decoded.expiresAt);
    jest.setSystemTime(now.getTime() + 900000);
    expect(() => cursors.decode(token, query)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }) as Error,
    );
  });

  it('binds every normalized query parameter, including page size', () => {
    const token = cursors.encode(query, row, snapshot);
    for (const change of [
      { limit: 21 },
      { sort: 'id' as const },
      { order: 'asc' as const },
      { status: 'active' as const },
      { searchBy: 'email' as const, q: 'abc' },
    ]) {
      expect(() => cursors.decode(token, { ...query, ...change })).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }) as Error,
      );
    }
  });

  it('rejects malformed, tampered and oversized cursors uniformly', () => {
    const token = cursors.encode(query, row, snapshot);
    for (const value of [
      '',
      'a.b.c',
      '!.abc',
      `${token.slice(0, -1)}!`,
      `${token}=`,
      'a'.repeat(8193),
    ]) {
      expect(() => cursors.decode(value, query)).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }) as Error,
      );
    }
    for (const change of [
      { kid: 'absent' },
      { v: 2 },
      { issuedAt: new Date(now.getTime() + 1).toISOString() },
      { expiresAt: new Date(now.getTime() + 900001).toISOString() },
      { snapshotAt: 'invalid' },
      { lastSortValue: 'invalid' },
      { lastTieBreaker: 'not-a-uuid' },
      { queryTag: 'invalid' },
      { extra: 'unexpected' },
    ]) {
      expect(() => cursors.decode(resign(token, change), query)).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }) as Error,
      );
    }
  });

  it('fails closed with 503 if the configured signing key is unavailable', () => {
    ring = [];
    expect(() => cursors.encode(query, row, snapshot)).toThrow(
      expect.objectContaining({ code: 'service_unavailable' }) as Error,
    );
  });
});
