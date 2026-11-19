import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ObjectStorage } from '@/modules/storage/object-storage';

import type { TempArea } from './temp-area';
import { TransformationsEraser } from './transformations-eraser';

type Row = { id: string; stored_file_key: string | null };

/** A database whose transaction runs the callback on a manager scripted per batch. */
function setup(batches: Row[][], deleteResult = 'deleted') {
  const queries: [string, unknown[]][] = [];
  let batch = 0;
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push([sql, params]);
      return Promise.resolve(sql.startsWith('SELECT') ? batches[batch++] : []);
    }),
  };
  const db = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      Promise.resolve(work(manager)),
    ),
  };
  const storage = { delete: jest.fn().mockResolvedValue(deleteResult) };
  const temp = { removePending: jest.fn().mockResolvedValue(undefined) };
  const eraser = new TransformationsEraser(
    db as unknown as DataSource,
    storage as unknown as ObjectStorage,
    temp as unknown as TempArea,
  );
  return { eraser, queries, storage, temp, db };
}
const rows = (n: number, key: (i: number) => string | null = () => null) =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    stored_file_key: key(i),
  }));

describe('TransformationsEraser (spec 2.0 §1.3.4, 2.4 §1.3.5)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it("deletes the user's rows in batches until a batch is short", async () => {
    const { eraser, queries, storage } = setup([rows(100), rows(3)]);
    expect(await eraser.eraseUserData('u')).toEqual({ result: 'succeeded' });
    expect(queries.filter(([sql]) => sql.startsWith('DELETE'))).toHaveLength(2);
    expect(queries[0]).toEqual([
      expect.stringContaining('FOR UPDATE'),
      ['u', 100],
    ]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes each stored object before its row, and its temporary copy', async () => {
    const { eraser, queries, storage, temp } = setup([
      rows(2, (i) => `key-${i}`),
    ]);
    expect(await eraser.eraseUserData('u')).toEqual({ result: 'succeeded' });
    expect(storage.delete.mock.calls).toEqual([['key-0'], ['key-1']]);
    expect(temp.removePending.mock.calls).toEqual([['key-0'], ['key-1']]);
    const remove = queries.find(([sql]) => sql.startsWith('DELETE'));
    expect(remove?.[1]).toEqual([['id-0', 'id-1']]);
  });

  it('a missing object counts as deleted', async () => {
    const { eraser } = setup([rows(1, () => 'k')], 'not_found');
    expect(await eraser.eraseUserData('u')).toEqual({ result: 'succeeded' });
  });

  it('unavailable storage keeps the rows and asks for a retry', async () => {
    const { eraser, queries, temp } = setup(
      [rows(2, () => 'k')],
      'unavailable',
    );
    expect(await eraser.eraseUserData('u')).toEqual({
      result: 'retryable_failure',
      code: 'storage_unavailable',
    });
    expect(queries.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    expect(temp.removePending).not.toHaveBeenCalled();
  });

  it('a database failure is retryable with a safe code', async () => {
    const { eraser, db } = setup([]);
    db.transaction.mockRejectedValue(new Error('down'));
    expect(await eraser.eraseUserData('u')).toEqual({
      result: 'retryable_failure',
      code: 'history_unavailable',
    });
  });
});
