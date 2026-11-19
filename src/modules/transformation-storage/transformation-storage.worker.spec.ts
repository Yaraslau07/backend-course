import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import type { ObjectStorage } from '@/modules/storage/object-storage';
import type { TempArea } from '@/modules/transformations/temp-area';

import { TransformationStorageWorker } from './transformation-storage.worker';

const KEY = 'b'.repeat(32);
const pending = (attempts = 0, ageSeconds = 0) => ({
  id: 'row-1',
  user_id: 'user-1',
  target_format: 'json',
  stored_file_key: KEY,
  storage_attempts: attempts,
  age_seconds: ageSeconds,
});

const fieldsOf = (spy: jest.SpyInstance) =>
  (spy.mock.calls[0] as [Record<string, unknown>])[0];

/** Scripted collaborators: `due` rows are returned one per SELECT, then none. */
function setup(
  due: ReturnType<typeof pending>[],
  {
    copy = Buffer.from('bytes') as Buffer | null,
    write = 'stored' as 'stored' | 'unavailable',
    env = 'test',
    workers = true,
  } = {},
) {
  const writes: [string, unknown[]][] = [];
  let next = 0;
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT'))
        return Promise.resolve(due[next++] ? [due[next - 1]] : []);
      writes.push([sql, params]);
      return Promise.resolve([]);
    }),
  };
  const db = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      Promise.resolve(work(manager)),
    ),
  };
  const storage = { write: jest.fn().mockResolvedValue(write) };
  const temp = {
    readPending: jest.fn().mockResolvedValue(copy),
    removePending: jest.fn().mockResolvedValue(undefined),
  };
  const worker = new TransformationStorageWorker(
    db as unknown as DataSource,
    storage as unknown as ObjectStorage,
    temp as unknown as TempArea,
    {
      get: (key: string) =>
        key === 'NODE_ENV'
          ? env
          : key === 'STORAGE_WORKERS_ENABLED'
            ? workers
            : key === 'TRANSFORMATION_STORED_FILE_RETENTION_DAYS'
              ? 90
              : undefined,
    } as unknown as ConfigService,
  );
  return { worker, writes, storage, temp, manager };
}

describe('TransformationStorageWorker (spec 2.4 §1.3.1 step 5)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes the copy under the row key with the target type, then marks it available', async () => {
    const s = setup([pending()]);
    expect(await s.worker.run()).toBe(1);
    expect(s.storage.write).toHaveBeenCalledWith(
      KEY,
      Buffer.from('bytes'),
      'application/json; charset=utf-8',
    );
    expect(s.writes[0][0]).toContain("storage_status = 'available'");
    expect(s.writes[0][1]).toEqual(['row-1', 1, 90]);
    expect(s.temp.removePending).toHaveBeenCalledWith(KEY);
  });

  it('claims rows without waiting on locked ones', async () => {
    const s = setup([]);
    await s.worker.run();
    const [sql] = s.manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("storage_status = 'pending'");
  });

  it('keeps the row pending with a doubling backoff, at most 15 minutes', async () => {
    const s = setup([pending(0), pending(2), pending(5, 3600)], {
      write: 'unavailable',
    });
    await s.worker.run();
    expect(s.writes[0][1]).toEqual(['row-1', 1, 30]);
    expect(s.writes[1][1]).toEqual(['row-1', 3, 120]);
    // Many failures later it still retries, every 15 minutes, and the counter stays at its cap.
    expect(s.writes[2][1]).toEqual(['row-1', 5, 900]);
    for (const [sql] of s.writes)
      expect(sql).not.toContain("storage_status = 'error'");
    expect(s.temp.removePending).not.toHaveBeenCalled();
  });

  it('gives up only after a day of retrying, keeping the key and dropping the copy', async () => {
    const s = setup([pending(5, 24 * 3600 - 1), pending(5, 24 * 3600 + 1)], {
      write: 'unavailable',
    });
    await s.worker.run();
    expect(s.writes[0][0]).not.toContain("storage_status = 'error'");
    expect(s.writes[1][0]).toContain("storage_status = 'error'");
    expect(s.writes[1][0]).not.toContain('stored_file_key');
    expect(s.writes[1][1]).toEqual(['row-1', 5]);
    expect(s.temp.removePending).toHaveBeenCalledTimes(1);
    expect(s.temp.removePending).toHaveBeenCalledWith(KEY);
  });

  it('a vanished copy is error at once, without touching storage', async () => {
    const s = setup([pending()], { copy: null });
    await s.worker.run();
    expect(s.storage.write).not.toHaveBeenCalled();
    expect(s.writes[0][0]).toContain("storage_status = 'error'");
  });

  it('logs the save with ids, size and result, but never the key or the bytes', async () => {
    await setup([pending()]).worker.run();
    const fields = fieldsOf(log);
    expect(fields).toMatchObject({
      event: 'transformation_storage',
      action: 'save',
      userId: 'user-1',
      transformationId: 'row-1',
      size: 5,
      result: 'available',
    });
    expect(JSON.stringify(fields)).not.toContain(KEY);
  });

  it('settles at most 20 rows per pass, and never overlaps itself', async () => {
    const s = setup(Array.from({ length: 30 }, () => pending()));
    const [a, b] = await Promise.all([s.worker.run(), s.worker.run()]);
    expect(a + b).toBe(20);
  });

  it('schedules itself only outside tests and when workers are enabled', () => {
    jest.useFakeTimers();
    const off = [
      setup([], { env: 'test' }),
      setup([], { env: 'production', workers: false }),
    ];
    for (const s of off) {
      s.worker.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
    }
    const on = setup([], { env: 'production' });
    on.worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    on.worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
