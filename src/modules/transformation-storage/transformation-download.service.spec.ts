import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import type {
  ObjectStorage,
  StorageRead,
} from '@/modules/storage/object-storage';

import { TransformationDownloadService } from './transformation-download.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const KEY = 'c'.repeat(32);
const item = (fields: Record<string, unknown> = {}) => ({
  id: ITEM,
  target_format: 'csv',
  output_size: '5',
  storage_status: 'available',
  stored_file_key: KEY,
  live: true,
  ...fields,
});

function setup(
  rows: Record<string, unknown>[],
  read: StorageRead = { kind: 'found', stream: Readable.from(['data']) },
  user: { id: string } | null = { id: OWNER },
) {
  const query = jest.fn((...args: [string, unknown[]?]) =>
    Promise.resolve(
      args[0].includes('FROM users') ? (user ? [user] : []) : rows,
    ),
  );
  const storage = { read: jest.fn().mockResolvedValue(read) };
  const service = new TransformationDownloadService(
    { query } as unknown as DataSource,
    storage as unknown as ObjectStorage,
  );
  return { service, query, storage };
}
const fieldsOf = (spy: jest.SpyInstance) =>
  (spy.mock.calls[0] as [Record<string, unknown>])[0];
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};
const text = async (stream: Readable) => {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
};

describe('TransformationDownloadService (spec 2.4 §1.3.2–1.3.3)', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('streams the stored object with the target format name and type', async () => {
    const s = setup([item()]);
    const file = await s.service.own(OWNER, ITEM);
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.fileName).toBe('converted.csv');
    expect(await text(file.stream)).toBe('data');
    expect(s.storage.read).toHaveBeenCalledWith(KEY);
    // The row is selected by id and the session's own user.
    expect(s.query.mock.calls[0][1]).toEqual([ITEM, OWNER]);
  });

  it.each([
    ['missing', []],
    ['unsaved', [item({ storage_status: 'not_requested' })]],
    ['failed', [item({ storage_status: 'error' })]],
    ['expired', [item({ live: false })]],
    ['keyless', [item({ stored_file_key: null })]],
  ])('%s is 404 and never reads storage', async (_name, rows) => {
    const s = setup(rows);
    expect(await codeOf(() => s.service.own(OWNER, ITEM))).toBe('not_found');
    expect(s.storage.read).not.toHaveBeenCalled();
  });

  it('a malformed id is bound as null, never cast', async () => {
    const s = setup([]);
    expect(await codeOf(() => s.service.own(OWNER, "x'; DROP"))).toBe(
      'not_found',
    );
    expect(s.query.mock.calls[0][1]).toEqual([null, OWNER]);
  });

  it('pending is 409 file_not_ready', async () => {
    const s = setup([
      item({ storage_status: 'pending', stored_file_key: KEY }),
    ]);
    expect(await codeOf(() => s.service.own(OWNER, ITEM))).toBe(
      'file_not_ready',
    );
  });

  it('a stored key whose object is gone is 503 with a mismatch event', async () => {
    const s = setup([item()], { kind: 'not_found' });
    expect(await codeOf(() => s.service.own(OWNER, ITEM))).toBe(
      'service_unavailable',
    );
    expect(fieldsOf(error)).toMatchObject({
      event: 'transformation_storage',
      result: 'storage_mismatch',
    });
  });

  it('unavailable storage is 503 too', async () => {
    const s = setup([item()], { kind: 'unavailable' });
    expect(await codeOf(() => s.service.own(OWNER, ITEM))).toBe(
      'service_unavailable',
    );
    expect(fieldsOf(error)).toMatchObject({
      result: 'storage_unavailable',
    });
  });

  it('a late stream failure becomes a safe error and a safe log line', async () => {
    const source = new Readable({ read() {} });
    const s = setup([item()], { kind: 'found', stream: source });
    const file = await s.service.own(OWNER, ITEM);
    const failing = text(file.stream).catch((e: unknown) => e);
    source.destroy(new Error('s3 secret detail'));
    const outcome = await failing;
    expect(outcome).toBeInstanceOf(AppException);
    expect(JSON.stringify(error.mock.calls)).not.toContain('s3 secret detail');
    expect(fieldsOf(error)).toMatchObject({ result: 'stream_failed' });
  });

  it('logs a download with ids, size and result, never the key', async () => {
    await setup([item()]).service.own(OWNER, ITEM);
    const fields = fieldsOf(log);
    expect(fields).toMatchObject({
      action: 'download',
      scope: 'self',
      actorUserId: OWNER,
      userId: OWNER,
      transformationId: ITEM,
      size: 5,
      result: 'success',
    });
    expect(JSON.stringify(fields)).not.toContain(KEY);
  });

  describe('admin', () => {
    const ADMIN = '33333333-3333-4333-8333-333333333333';

    it("finds the user first (404), then the item among that user's", async () => {
      const gone = setup([item()], undefined, null);
      expect(await codeOf(() => gone.service.ofUser(ADMIN, OWNER, ITEM))).toBe(
        'not_found',
      );
      expect(gone.storage.read).not.toHaveBeenCalled();

      const s = setup([item()]);
      const file = await s.service.ofUser(ADMIN, OWNER, ITEM);
      expect(await text(file.stream)).toBe('data');
      expect(s.query.mock.calls[1][1]).toEqual([ITEM, OWNER]);
      expect(fieldsOf(log)).toMatchObject({
        scope: 'admin',
        actorUserId: ADMIN,
        userId: OWNER,
      });
    });

    it('rejects a malformed user id with 400 and binds a valid non-UUID as null', async () => {
      const s = setup([]);
      expect(await codeOf(() => s.service.ofUser(ADMIN, 'a/b', ITEM))).toBe(
        'bad_request',
      );
      expect(s.query).not.toHaveBeenCalled();
      await codeOf(() => s.service.ofUser(ADMIN, 'not-a-uuid', ITEM));
      expect(s.query.mock.calls[0][1]).toEqual([null]);
    });
  });
});
