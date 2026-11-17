import { DataSource, type EntityManager } from 'typeorm';
import { ConfigService } from '@/core/config/config.service';
import { ObjectStorage, STORAGE_ADOPTION_LOCK } from './object-storage';
import { StorageCleanup } from './storage-cleanup.service';

const key = '11111111-1111-4111-8111-111111111111.webp';
function setup(
  options: {
    attempts?: number;
    referenced?: boolean;
    locked?: boolean;
    job?: boolean;
  } = {},
) {
  let selected = false;
  const sql = jest.fn((text: string): Promise<unknown> => {
    if (text.startsWith('SELECT id, storage_key')) {
      if (selected || options.job === false) return Promise.resolve([]);
      selected = true;
      return Promise.resolve([
        { id: 'job-id', storage_key: key, attempts: options.attempts ?? 0 },
      ]);
    }
    if (text.startsWith('SELECT 1'))
      return Promise.resolve(options.referenced ? [{ present: 1 }] : []);
    if (text.includes('pg_try_advisory_xact_lock'))
      return Promise.resolve([{ locked: options.locked ?? true }]);
    if (text.includes('AS cutoff'))
      return Promise.resolve([{ cutoff: new Date('2026-11-17T12:00:00Z') }]);
    if (text.startsWith('SELECT photo_key'))
      return Promise.resolve(options.referenced ? [{ photo_key: key }] : []);
    return Promise.resolve([]);
  });
  const db = {
    query: sql,
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work({ query: sql } as unknown as EntityManager),
  };
  const storage = {
    delete: jest.fn().mockResolvedValue('deleted'),
    list: jest.fn().mockResolvedValue({
      kind: 'listed',
      objects: [{ key, modifiedAt: new Date('2026-11-17T11:00:00Z') }],
    }),
  };
  const worker = new StorageCleanup(
    db as unknown as DataSource,
    storage as unknown as ObjectStorage,
    { get: () => 'test' } as unknown as ConfigService,
  );
  return { worker, storage, sql };
}
describe('storage cleanup and reconciliation', () => {
  it.each(['deleted', 'not_found'])(
    'treats %s as success and uses SKIP LOCKED',
    async (result) => {
      const s = setup();
      s.storage.delete.mockResolvedValue(result);
      expect(await s.worker.run()).toBe(1);
      expect(s.sql).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      );
      expect(s.sql).toHaveBeenCalledWith(
        expect.stringContaining('attempts = attempts + 1'),
        ['job-id', 'succeeded', null],
      );
    },
  );
  it.each([0, 4])(
    'retries up to five starts, starting with %s',
    async (attempts) => {
      const s = setup({ attempts });
      s.storage.delete.mockResolvedValue('unavailable');
      await s.worker.run();
      expect(s.sql).toHaveBeenCalledWith(
        expect.stringContaining("interval '1 minute'"),
        ['job-id', attempts === 4 ? 'failed' : 'queued', 'storage_unavailable'],
      );
    },
  );
  it('never deletes a referenced key and stops empty queues', async () => {
    const s = setup({ referenced: true });
    await s.worker.run();
    expect(s.storage.delete).not.toHaveBeenCalled();
    expect(s.sql).toHaveBeenCalledWith(
      expect.stringContaining('attempts = attempts + 1'),
      ['job-id', 'failed', 'still_referenced'],
    );
    expect(await setup({ job: false }).worker.run()).toBe(0);
  });
  it('sweeps only old generated unreferenced keys under the adoption lock', async () => {
    const s = setup();
    s.storage.list.mockResolvedValue({
      kind: 'listed',
      objects: [
        { key, modifiedAt: new Date('2026-11-17T11:00:00Z') },
        { key: 'manual-key', modifiedAt: new Date(0) },
        {
          key: '22222222-2222-4222-8222-222222222222.webp',
          modifiedAt: new Date('2026-11-17T12:01:00Z'),
        },
      ],
    });
    expect(await s.worker.sweep()).toBe(1);
    expect(s.sql).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_xact_lock'),
      [STORAGE_ADOPTION_LOCK],
    );
    expect(s.storage.delete).toHaveBeenCalledTimes(1);
    expect(s.storage.delete).toHaveBeenCalledWith(key);
    const protectedRun = setup({ referenced: true });
    expect(await protectedRun.worker.sweep()).toBe(0);
    expect(protectedRun.storage.delete).not.toHaveBeenCalled();
  });
  it('stops a sweep after an unavailable delete instead of repeating failures under the upload lock', async () => {
    const s = setup();
    s.storage.delete.mockResolvedValue('unavailable');
    expect(await s.worker.sweep()).toBe(0);
    expect(s.storage.delete).toHaveBeenCalledTimes(1);
  });

  it('does not race uploads and tolerates unavailable listings', async () => {
    const s = setup({ locked: false });
    expect(await s.worker.sweep()).toBe(0);
    expect(s.storage.list).not.toHaveBeenCalled();
    const down = setup();
    down.storage.list.mockResolvedValue({ kind: 'unavailable' });
    expect(await down.worker.sweep()).toBe(0);
  });
  it('follows pages, stops repeated cursors and allows retry after a database failure', async () => {
    const s = setup();
    s.storage.list
      .mockResolvedValueOnce({ kind: 'listed', objects: [], cursor: 'next' })
      .mockResolvedValueOnce({ kind: 'listed', objects: [], cursor: 'next' });
    expect(await s.worker.sweep()).toBe(0);
    expect(s.storage.list).toHaveBeenCalledTimes(2);
    s.sql.mockRejectedValueOnce(new Error('db down'));
    await expect(s.worker.run()).rejects.toThrow('db down');
    expect(await s.worker.run()).toBe(1);
  });
  it('does not schedule background work in test apps', () => {
    const s = setup();
    const interval = jest.spyOn(global, 'setInterval');
    s.worker.onModuleInit();
    s.worker.onModuleDestroy();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});
