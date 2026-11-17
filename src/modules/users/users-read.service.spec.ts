import { Readable } from 'node:stream';

import { DataSource, type EntityManager } from 'typeorm';

import { Ownership } from '@/core/authorization/ownership';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { ObjectStorage } from '@/modules/storage/object-storage';

import type { ProfileRow } from './safe-profile';
import { UserListCursor, type ListCursor } from './user-list-cursor.service';
import { UsersReadService } from './users-read.service';

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const snapshot = new Date('2026-11-17T12:00:00.000Z');
const row: ProfileRow = {
  id: target,
  email: 'safe@example.com',
  display_name: null,
  photo_key: 'opaque',
  status: 'active',
  created_at: new Date('2026-11-01T00:00:00.123Z'),
  updated_at: snapshot,
};
const unavailable = () =>
  Object.assign(new Error('private database detail'), { code: '57014' });

function setup(rows: ProfileRow[] = [row]) {
  const lookup = jest.fn().mockResolvedValue(rows);
  const sql = jest.fn((text: string): Promise<unknown> => {
    if (text.startsWith('SET LOCAL')) return Promise.resolve([]);
    if (text.includes('snapshot_at'))
      return Promise.resolve([{ snapshot_at: snapshot }]);
    return Promise.resolve(rows);
  });
  const transaction = jest.fn(
    async (callback: (m: EntityManager) => Promise<unknown>) =>
      callback({ query: sql } as unknown as EntityManager),
  );
  const ownership = { selfOr: jest.fn().mockResolvedValue('foreign') };
  const limiter = { enforce: jest.fn().mockResolvedValue(undefined) };
  const storage = { read: jest.fn().mockResolvedValue({ kind: 'not_found' }) };
  const cursors = {
    encode: jest.fn().mockReturnValue('signed-cursor'),
    decode: jest.fn().mockReturnValue({
      snapshotAt: snapshot.toISOString(),
      lastSortValue: row.created_at.toISOString(),
      lastTieBreaker: target,
    } as ListCursor),
  };
  const service = new UsersReadService(
    { query: lookup, transaction } as unknown as DataSource,
    { get: () => 'https://api.example.com' } as unknown as ConfigService,
    ownership as unknown as Ownership,
    limiter as unknown as RateLimiter,
    storage as unknown as ObjectStorage,
    cursors as unknown as UserListCursor,
  );
  return {
    service,
    lookup,
    sql,
    transaction,
    ownership,
    limiter,
    storage,
    cursors,
  };
}

describe('profile/photo reads', () => {
  it('rate-limits, checks ownership, then selects only safe columns', async () => {
    const s = setup();
    await s.service.profile(actor, target);
    expect(s.limiter.enforce).toHaveBeenCalledWith('profile_read_foreign', [
      actor,
    ]);
    expect(s.ownership.selfOr).toHaveBeenCalledWith(
      actor,
      target,
      'users',
      'read_any',
      'UsersRead.profile',
    );
    expect(s.limiter.enforce.mock.invocationCallOrder[0]).toBeLessThan(
      s.ownership.selfOr.mock.invocationCallOrder[0],
    );
    expect(s.ownership.selfOr.mock.invocationCallOrder[0]).toBeLessThan(
      s.lookup.mock.invocationCallOrder[0],
    );
    expect(s.lookup).toHaveBeenCalledWith(
      'SELECT id, email, display_name, photo_key, status, created_at, updated_at FROM users WHERE id = $1',
      [target],
    );
  });

  it('uses the self budget for an uppercase own UUID', async () => {
    const s = setup();
    await s.service.profile(actor, actor.toUpperCase());
    expect(s.limiter.enforce).toHaveBeenCalledWith('profile_read_self', [
      actor,
    ]);
  });

  it('never looks up a target before ownership allows it', async () => {
    const s = setup();
    s.ownership.selfOr.mockRejectedValue(new AppException('ownership_denied'));
    await expect(s.service.profile(actor, target)).rejects.toMatchObject({
      code: 'ownership_denied',
    });
    expect(s.lookup).not.toHaveBeenCalled();
    s.limiter.enforce.mockRejectedValue(new AppException('too_many_requests'));
    s.ownership.selfOr.mockClear();
    await expect(s.service.photo(actor, target)).rejects.toMatchObject({
      code: 'too_many_requests',
    });
    expect(s.ownership.selfOr).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs and queries valid non-UUID IDs safely as absent', async () => {
    const s = setup([]);
    await expect(s.service.profile(actor, 'bad.id')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(s.limiter.enforce).not.toHaveBeenCalled();
    await expect(
      s.service.profile(actor, 'valid-but-absent'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(s.lookup).toHaveBeenCalledWith(expect.any(String), [null]);
  });

  it('turns database unavailability into 503 and preserves unexpected errors', async () => {
    const s = setup();
    s.lookup.mockRejectedValue(unavailable());
    await expect(s.service.profile(actor, target)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    const unexpected = new Error('unexpected');
    s.lookup.mockRejectedValue(unexpected);
    await expect(s.service.photo(actor, target)).rejects.toBe(unexpected);
  });

  it.each([
    { rows: [] },
    { rows: [{ ...row, photo_key: null }] },
    { rows: [{ ...row, status: 'deleting' as const }] },
    { rows: [{ ...row, status: 'deleted' as const }] },
  ])('does not read storage for an unavailable photo', async ({ rows }) => {
    const s = setup(rows);
    await expect(s.service.photo(actor, target)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(s.storage.read).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'unavailable'])(
    'maps storage %s to 503',
    async (kind) => {
      const s = setup();
      s.storage.read.mockResolvedValue({ kind });
      await expect(s.service.photo(actor, target)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    },
  );

  it('streams bytes and replaces late storage errors with a safe error', async () => {
    const s = setup();
    const source = new Readable({
      read() {
        this.destroy(new Error('private storage path'));
      },
    });
    s.storage.read.mockResolvedValue({ kind: 'found', stream: source });
    const result = await s.service.photo(actor, target);
    await expect(
      (async () => {
        for await (const chunk of result) void chunk;
      })(),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(source.destroyed).toBe(true);
  });
});

describe('bounded list queries', () => {
  it('sets a local SQL timeout, reads the database clock, and fetches limit+1', async () => {
    const s = setup([row, row]);
    const result = await s.service.list(actor, { limit: '1' });
    expect(s.sql.mock.calls[0][0]).toBe("SET LOCAL statement_timeout = '2s'");
    expect(s.sql.mock.calls[1][0]).toContain('clock_timestamp()');
    expect(s.sql).toHaveBeenLastCalledWith(
      expect.stringContaining('ORDER BY created_at DESC, id DESC LIMIT $2'),
      [snapshot.toISOString(), 2],
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('signed-cursor');
    expect(s.cursors.encode).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
      row,
      snapshot.toISOString(),
    );
    expect(s.storage.read).not.toHaveBeenCalled();
  });

  it.each(['createdAt', 'id'])(
    'continues a %s cursor in both directions without a new clock',
    async (sort) => {
      for (const order of ['asc', 'desc']) {
        const s = setup([row, row]);
        const lastSortValue =
          sort === 'id' ? target : row.created_at.toISOString();
        const lastTieBreaker =
          sort === 'id' ? row.created_at.toISOString() : target;
        s.cursors.decode.mockReturnValue({
          snapshotAt: snapshot.toISOString(),
          lastSortValue,
          lastTieBreaker,
        } as ListCursor);
        await s.service.list(actor, {
          cursor: 'previous',
          sort,
          order,
          limit: '1',
        });
        expect(s.sql).toHaveBeenCalledTimes(2);
        const fields = sort === 'id' ? '(id, created_at)' : '(created_at, id)';
        expect(s.sql).toHaveBeenLastCalledWith(
          expect.stringContaining(`${fields} ${order === 'asc' ? '>' : '<'}`),
          [snapshot.toISOString(), lastSortValue, lastTieBreaker, 2],
        );
        expect(s.cursors.encode).toHaveBeenCalledWith(
          expect.any(Object),
          row,
          expect.objectContaining({ snapshotAt: snapshot.toISOString() }),
        );
      }
    },
  );

  it.each(['email', 'displayName'])(
    'parameterizes %s and escapes wildcard characters',
    async (searchBy) => {
      const s = setup();
      await s.service.list(actor, { searchBy, q: "ab_%\\'", status: 'active' });
      const statement = s.sql.mock.calls.at(-1)![0];
      expect(statement).not.toContain('ab_%');
      expect(s.sql).toHaveBeenLastCalledWith(expect.any(String), [
        snapshot.toISOString(),
        'active',
        "ab\\_\\%\\\\'%",
        21,
      ]);
    },
  );

  it('returns an empty final page without a cursor or total count', async () => {
    const s = setup([]);
    expect(
      await s.service.list(actor, { searchBy: 'id', q: 'not-a-uuid' }),
    ).toEqual({ items: [], nextCursor: null });
    expect(s.sql).toHaveBeenLastCalledWith(
      expect.stringContaining('id = $2::uuid'),
      [snapshot.toISOString(), null, 21],
    );
    expect(s.cursors.encode).not.toHaveBeenCalled();
  });

  it('validates query/cursor before starting a list transaction and never returns a partial page', async () => {
    const s = setup();
    await expect(s.service.list(actor, { unknown: 'x' })).rejects.toMatchObject(
      { code: 'bad_request' },
    );
    expect(s.transaction).not.toHaveBeenCalled();
    s.cursors.decode.mockImplementation(() => {
      throw new AppException('invalid_cursor');
    });
    await expect(
      s.service.list(actor, { cursor: 'broken' }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect(s.transaction).not.toHaveBeenCalled();
    s.sql.mockRejectedValueOnce(unavailable());
    await expect(s.service.list(actor, {})).rejects.toMatchObject({
      code: '57014',
    });
    expect(s.cursors.encode).not.toHaveBeenCalled();
  });
});
