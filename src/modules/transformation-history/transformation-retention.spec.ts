import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import type { ObjectStorage } from '@/modules/storage/object-storage';
import type { TempArea } from '@/modules/transformations/temp-area';

import { TransformationRetention } from './transformation-retention.service';

type Row = { id: string; user_id: string; stored_file_key: string | null };
const row = (n: number, key: string | null = null): Row => ({
  id: `id-${n}`,
  user_id: 'u',
  stored_file_key: key,
});
const many = (count: number, key = false) =>
  Array.from({ length: count }, (_, n) => row(n, key ? `k${n}` : null));

/** `expired` and `old` are the SELECT results, one per call; everything else answers []. */
function setup(
  { expired = [], old = [] }: { expired?: Row[][]; old?: Row[][] },
  env = 'test',
  deleteResult: 'deleted' | 'not_found' | 'unavailable' = 'deleted',
  workers = true,
) {
  const writes: [string, unknown[]][] = [];
  const selects = { expired: 0, old: 0 };
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT'))
        return Promise.resolve(
          sql.includes("storage_status = 'available'")
            ? (expired[selects.expired++] ?? [])
            : (old[selects.old++] ?? []),
        );
      writes.push([sql, params]);
      return Promise.resolve([]);
    }),
  };
  const db = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      Promise.resolve(work(manager)),
    ),
  };
  const storage = { delete: jest.fn().mockResolvedValue(deleteResult) };
  const temp = { removePending: jest.fn().mockResolvedValue(undefined) };
  const retention = new TransformationRetention(
    db as unknown as DataSource,
    {
      get: (key: string) =>
        key === 'NODE_ENV'
          ? env
          : key === 'TRANSFORMATION_HISTORY_RETENTION_DAYS'
            ? 90
            : key === 'STORAGE_WORKERS_ENABLED'
              ? workers
              : undefined,
    } as unknown as ConfigService,
    storage as unknown as ObjectStorage,
    temp as unknown as TempArea,
  );
  return { retention, manager, writes, storage, temp, selects };
}
const deletes = (writes: [string, unknown[]][]) =>
  writes.filter(([sql]) => sql.startsWith('DELETE'));

describe('TransformationRetention (spec 2.3 §1.3.5, §1.6; spec 2.4 §1.3.5)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('deletes rows older than the period in small batches until a batch is short', async () => {
    const { retention, manager, writes } = setup({
      old: [many(500), many(500), many(12)],
    });
    expect(await retention.run()).toBe(1012);
    expect(deletes(writes)).toHaveLength(3);
    const select = manager.query.mock.calls.find(([sql]) =>
      sql.includes('created_at <'),
    );
    expect(select?.[0]).toContain('LIMIT');
    expect(select?.[1]).toEqual([90, 500]);
  });

  it('stops after its batch budget, leaving the rest for the next sweep', async () => {
    const { retention, selects } = setup({
      old: Array.from({ length: 30 }, () => many(500)),
    });
    expect(await retention.run()).toBe(20 * 500);
    expect(selects.old).toBe(20);
  });

  it("deletes a row's object before the row, and its temporary copy", async () => {
    const { retention, storage, temp, writes } = setup({
      old: [[row(1, 'k1'), row(2)]],
    });
    expect(await retention.run()).toBe(2);
    expect(storage.delete.mock.calls).toEqual([['k1']]);
    expect(temp.removePending.mock.calls).toEqual([['k1']]);
    expect(deletes(writes)[0][1]).toEqual([['id-1', 'id-2']]);
  });

  it('a missing object counts as deleted', async () => {
    const { retention } = setup({ old: [[row(1, 'k1')]] }, 'test', 'not_found');
    expect(await retention.run()).toBe(1);
  });

  it('keeps a row whose object cannot be deleted, and ends the sweep', async () => {
    const { retention, writes, selects } = setup(
      { old: [[row(1, 'k1'), row(2)], many(500)] },
      'test',
      'unavailable',
    );
    expect(await retention.run()).toBe(1);
    expect(deletes(writes)[0][1]).toEqual([['id-2']]);
    expect(selects.old).toBe(1);
  });

  it('clears an expired stored file: object deleted, fields cleared, row kept', async () => {
    const { retention, storage, writes } = setup({
      expired: [[row(1, 'k1')]],
    });
    expect(await retention.run()).toBe(0);
    expect(storage.delete).toHaveBeenCalledWith('k1');
    const update = writes.find(([sql]) => sql.startsWith('UPDATE'));
    expect(update?.[0]).toContain("storage_status = 'not_requested'");
    expect(update?.[1]).toEqual([['id-1']]);
    expect(deletes(writes)).toHaveLength(0);
  });

  it('leaves an expired file alone while storage is unavailable', async () => {
    const { retention, writes } = setup(
      { expired: [[row(1, 'k1')]] },
      'test',
      'unavailable',
    );
    await retention.run();
    expect(writes).toHaveLength(0);
  });

  it('keeps sweeping full batches of expired files', async () => {
    const { retention, selects } = setup({
      expired: [many(50, true), many(3, true)],
    });
    await retention.run();
    expect(selects.expired).toBe(2);
  });

  it('does not schedule itself in tests, and never overlaps', async () => {
    const { retention, selects } = setup({});
    retention.onModuleInit();
    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    expect(a + b).toBe(0);
    expect(selects.expired).toBe(1);
    retention.onModuleDestroy();
  });

  it('deletes at most 50 objects per batch and carries the rest to the next batch', async () => {
    const { retention, storage, selects } = setup({
      old: [many(120, true), many(70, true), []],
    });
    expect(await retention.run()).toBe(100);
    expect(storage.delete).toHaveBeenCalledTimes(100);
    // Rows deferred by the cap keep the sweep going until a batch has none left.
    expect(selects.old).toBe(3);
  });

  it('does not schedule itself when the storage workers are off', () => {
    jest.useFakeTimers();
    const { retention } = setup({}, 'production', 'deleted', false);
    retention.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('schedules itself outside tests', () => {
    jest.useFakeTimers();
    const { retention } = setup({}, 'production');
    retention.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    retention.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
