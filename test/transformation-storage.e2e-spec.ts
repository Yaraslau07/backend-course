import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { TransformationsEraser } from '@/modules/transformations/transformations-eraser';
import { TransformationRetention } from '@/modules/transformation-history/transformation-retention.service';
import { TransformationStorageWorker } from '@/modules/transformation-storage/transformation-storage.worker';

import { ip } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import { type Actor, actorWithRoles, ensureBootstrapped } from './utils/rbac';
import { TransformProbeModule } from './utils/transform-probe.module';

const logs = new LogCapture();
const sensitive: string[] = [];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let temp: string;
let store: string;
let member: Actor;
let admin: Actor;
let worker: TransformationStorageWorker;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'c19-temp-'));
  store = await mkdtemp(join(tmpdir(), 'c19-store-'));
  ({ app, config } = await createTestApp({
    logs,
    imports: [TransformProbeModule],
    env: { TRANSFORMATION_TEMP_DIR: temp, STORAGE_LOCAL_ROOT: store },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  await app.get(RbacPermissionSeeds).applyAll();
  worker = app.get(TransformationStorageWorker);
  member = await actorWithRoles(app, ['user']);
  admin = await actorWithRoles(app, ['admin']);
});
beforeEach(() => resetRateLimits(app));
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
  await rm(temp, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
});

function multipart(parts: { field: string; value: string }[], content: string) {
  const boundary = `----c19${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
      ),
    );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.probe"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    ),
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function convert(
  actor: Actor,
  options: { save?: string; content?: string; mode?: string } = {},
) {
  const body = multipart(
    [
      { field: 'targetFormat', value: 'upper' },
      ...(options.mode ? [{ field: 'mode', value: options.mode }] : []),
      ...(options.save === undefined
        ? []
        : [{ field: 'save', value: options.save }]),
    ],
    options.content ?? 'hello storage',
  );
  return app.inject({
    method: 'POST',
    url: '/test/transform',
    cookies: actor.cookies,
    payload: body.payload,
    headers: body.headers,
    remoteAddress: ip(),
  });
}

function get(actor: Actor | undefined, url: string) {
  return app.inject({
    method: 'GET',
    url,
    cookies: actor?.cookies,
    remoteAddress: ip(),
  });
}
const download = (actor: Actor | undefined, id: string) =>
  get(actor, `/api/transformations/history/${id}/download`);
const adminDownload = (actor: Actor | undefined, userId: string, id: string) =>
  get(actor, `/admin/users/${userId}/transformations/history/${id}/download`);

interface StorageRow {
  storage_status: string;
  stored_file_key: string | null;
  stored_file_until: Date | null;
  storage_attempts: number;
}
async function row(id: string): Promise<StorageRow | undefined> {
  const [found] = await db.query<StorageRow[]>(
    `SELECT storage_status, stored_file_key, stored_file_until, storage_attempts
       FROM transformations WHERE id = $1`,
    [id],
  );
  return found;
}
const objects = async () => readdir(store);
const pendingCopies = async () =>
  readdir(join(temp, 'pending')).catch(() => [] as string[]);
/** Makes every pending row due now, as if its backoff had passed. */
const makeDue = () =>
  db.query(
    `UPDATE transformations SET storage_next_attempt_at = clock_timestamp() - interval '1 second'
      WHERE storage_status = 'pending'`,
  );

/** A saved conversion that the worker has already written: the happy path. */
async function saved(actor: Actor, content = 'hello storage') {
  const res = await convert(actor, { save: 'true', content });
  expect(res.statusCode).toBe(200);
  const id = res.headers['x-transformation-id'] as string;
  await worker.run();
  return { id, res };
}

describe('the save flag (spec 2.4 §1.3.1)', () => {
  it('save missing or false: result returned, no key, no copy, X-Save-Status not_requested', async () => {
    for (const save of [undefined, 'false']) {
      const res = await convert(member, { save });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('not_requested');
      const stored = await row(res.headers['x-transformation-id'] as string);
      expect(stored).toMatchObject({
        storage_status: 'not_requested',
        stored_file_key: null,
        stored_file_until: null,
      });
    }
    expect(await pendingCopies()).toEqual([]);
  });

  it.each(['yes', 'TRUE', '1', ''])(
    'save=%j is 400 and writes no history',
    async (save) => {
      const before = await db.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM transformations WHERE user_id = $1`,
        [member.id],
      );
      const res = await convert(member, { save });
      expect(res.statusCode).toBe(400);
      const after = await db.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM transformations WHERE user_id = $1`,
        [member.id],
      );
      expect(after).toEqual(before);
    },
  );

  it('save=true returns the file at once; the row is pending with a random key and a private copy', async () => {
    const res = await convert(member, { save: 'true' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('HELLO STORAGE');
    expect(res.headers['x-save-status']).toBe('pending');
    const stored = await row(res.headers['x-transformation-id'] as string);
    expect(stored?.storage_status).toBe('pending');
    expect(stored?.stored_file_key).toMatch(/^[0-9a-f]{32}$/);
    expect(stored?.stored_file_until).toBeNull();
    expect(await pendingCopies()).toContain(stored?.stored_file_key);
    // Nothing reached the object store yet: the response didn't wait for it.
    expect(await objects()).not.toContain(stored?.stored_file_key);
    sensitive.push(stored?.stored_file_key as string);
  });

  it('a failed conversion with save=true saves nothing and sends no save header', async () => {
    const res = await convert(member, { save: 'true', mode: 'fail' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-save-status']).toBeUndefined();
    const [last] = await db.query<StorageRow[]>(
      `SELECT storage_status, stored_file_key, stored_file_until, storage_attempts
         FROM transformations WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [member.id],
    );
    expect(last).toMatchObject({
      storage_status: 'not_requested',
      stored_file_key: null,
    });
  });

  it('if no copy can be made the file is still returned and the row is error', async () => {
    await rm(join(temp, 'pending'), { recursive: true, force: true });
    await writeFile(join(temp, 'pending'), 'not a directory');
    try {
      const res = await convert(member, { save: 'true' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('HELLO STORAGE');
      expect(res.headers['x-save-status']).toBe('error');
      const stored = await row(res.headers['x-transformation-id'] as string);
      expect(stored?.storage_status).toBe('error');
    } finally {
      await rm(join(temp, 'pending'), { force: true });
    }
  });
});

describe('the background write (spec 2.4 §1.3.1 step 5)', () => {
  it('pending → available: object written under the known key, until set, copy removed', async () => {
    const { id } = await saved(member);
    const stored = await row(id);
    expect(stored?.storage_status).toBe('available');
    const key = stored?.stored_file_key as string;
    expect(await objects()).toContain(key);
    expect(await readFile(join(store, key), 'utf8')).toBe('HELLO STORAGE');
    const days =
      ((stored?.stored_file_until as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    expect(await pendingCopies()).not.toContain(key);
    sensitive.push(key);
  });

  it('storage unavailable: the row stays pending and retries with the same key', async () => {
    const res = await convert(member, { save: 'true' });
    const id = res.headers['x-transformation-id'] as string;
    const key = (await row(id))?.stored_file_key as string;
    const write = jest
      .spyOn(app.get(ObjectStorage), 'write')
      .mockResolvedValue('unavailable');
    await worker.run();
    expect(await row(id)).toMatchObject({
      storage_status: 'pending',
      stored_file_key: key,
      storage_attempts: 1,
    });
    expect(await pendingCopies()).toContain(key);
    // Backed off: an immediate second pass leaves it alone.
    await worker.run();
    expect((await row(id))?.storage_attempts).toBe(1);

    write.mockRestore();
    await makeDue();
    await worker.run();
    expect(await row(id)).toMatchObject({
      storage_status: 'available',
      stored_file_key: key,
    });
  });

  it('keeps retrying through a long outage, and gives up only after a day (D81)', async () => {
    const res = await convert(member, { save: 'true' });
    const id = res.headers['x-transformation-id'] as string;
    const key = (await row(id))?.stored_file_key as string;
    jest
      .spyOn(app.get(ObjectStorage), 'write')
      .mockResolvedValue('unavailable');
    // Many failed writes later it is still pending, with its copy.
    for (let attempt = 0; attempt < 8; attempt++) {
      await makeDue();
      await worker.run();
    }
    expect(await row(id)).toMatchObject({
      storage_status: 'pending',
      storage_attempts: 5,
    });
    expect(await pendingCopies()).toContain(key);

    // After a day of waiting the save is an error and the copy is gone.
    await db.query(
      `UPDATE transformations SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [id],
    );
    await makeDue();
    await worker.run();
    expect((await row(id))?.storage_status).toBe('error');
    expect(await pendingCopies()).not.toContain(key);
    const history = (
      await get(member, `/api/transformations/history?limit=100`)
    ).json<{ items: Record<string, unknown>[] }>();
    expect(history.items.find((item) => item.id === id)).toMatchObject({
      status: 'success',
      storageStatus: 'error',
      hasStoredFile: false,
      fileExpiresAt: null,
    });
    expect((await download(member, id)).statusCode).toBe(404);
  });

  it('a vanished temporary copy turns the save into error', async () => {
    const res = await convert(member, { save: 'true' });
    const id = res.headers['x-transformation-id'] as string;
    const key = (await row(id))?.stored_file_key as string;
    await rm(join(temp, 'pending', key));
    await worker.run();
    expect((await row(id))?.storage_status).toBe('error');
  });

  it('writing again with the same key creates no second object', async () => {
    const res = await convert(member, { save: 'true' });
    const id = res.headers['x-transformation-id'] as string;
    const key = (await row(id))?.stored_file_key as string;
    // As if an earlier attempt wrote the object but crashed before the row was updated.
    expect(
      await app
        .get(ObjectStorage)
        .write(key, Buffer.from('HELLO STORAGE'), 'text/plain'),
    ).toBe('stored');
    const before = (await objects()).length;
    await worker.run();
    expect((await row(id))?.storage_status).toBe('available');
    expect((await objects()).length).toBe(before);
    expect(await readFile(join(store, key), 'utf8')).toBe('HELLO STORAGE');
  });
});

describe('own download (spec 2.4 §1.3.2)', () => {
  it('returns the saved file with the contract headers', async () => {
    const { id } = await saved(member);
    const res = await download(member, id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('HELLO STORAGE');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="converted.upper"',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toBeDefined();
  });

  it('pending is 409 file_not_ready', async () => {
    const res = await convert(member, { save: 'true' });
    const out = await download(
      member,
      res.headers['x-transformation-id'] as string,
    );
    expect(out.statusCode).toBe(409);
    expect(out.json()).toMatchObject({ code: 'file_not_ready' });
  });

  it('unsaved, foreign, missing and malformed ids are all 404 (no IDOR hint)', async () => {
    const plain = await convert(member);
    const other = await actorWithRoles(app, ['user']);
    const { id: foreign } = await saved(other);
    for (const id of [
      plain.headers['x-transformation-id'] as string,
      foreign,
      randomUUID(),
      'not-a-uuid',
    ]) {
      const res = await download(member, id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('is 401 without a session and 403 without transformations@download, before any lookup', async () => {
    const { id } = await saved(member);
    expect((await download(undefined, id)).statusCode).toBe(401);
    const nobody = await actorWithRoles(app, []);
    // The same answer for a real item and a missing one: the permission comes first.
    expect((await download(nobody, id)).statusCode).toBe(403);
    expect((await download(nobody, randomUUID())).statusCode).toBe(403);
  });

  it('an expired file is 404', async () => {
    const { id } = await saved(member);
    await db.query(
      `UPDATE transformations SET stored_file_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect((await download(member, id)).statusCode).toBe(404);
  });

  it('a key whose object is gone is 503 and logs a mismatch', async () => {
    const { id } = await saved(member);
    const key = (await row(id))?.stored_file_key as string;
    await rm(join(store, key));
    logs.clear();
    const res = await download(member, id);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(key);
    expect(logs.text()).toContain('transformation_storage');
    expect(logs.text()).not.toContain(key);
  });
});

describe('admin download (spec 2.4 §1.3.3)', () => {
  it("returns another user's file", async () => {
    const { id } = await saved(member, 'for the admin');
    const res = await adminDownload(admin, member.id, id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('FOR THE ADMIN');
  });

  it('403 without download_any, before the user is looked up', async () => {
    const { id } = await saved(member);
    expect((await adminDownload(member, member.id, id)).statusCode).toBe(403);
    expect((await adminDownload(member, randomUUID(), id)).statusCode).toBe(
      403,
    );
  });

  it('404 for a missing user, a missing item, or an item of another user', async () => {
    const { id } = await saved(member);
    const other = await actorWithRoles(app, ['user']);
    for (const [user, item] of [
      [randomUUID(), id],
      [member.id, randomUUID()],
      [other.id, id],
      ['not-a-uuid', id],
    ])
      expect((await adminDownload(admin, user, item)).statusCode).toBe(404);
  });

  it('pending is 409 for the admin too', async () => {
    const res = await convert(member, { save: 'true' });
    const out = await adminDownload(
      admin,
      member.id,
      res.headers['x-transformation-id'] as string,
    );
    expect(out.statusCode).toBe(409);
  });
});

describe('history fields (spec 2.4 §1.3.4)', () => {
  it('shows pending, then available with fileExpiresAt, and never the key', async () => {
    const res = await convert(member, { save: 'true' });
    const id = res.headers['x-transformation-id'] as string;
    const key = (await row(id))?.stored_file_key as string;
    const list = async () =>
      (await get(member, '/api/transformations/history?limit=100'))
        .json<{
          items: Record<string, unknown>[];
        }>()
        .items.find((item) => item.id === id);

    expect(await list()).toMatchObject({
      storageStatus: 'pending',
      hasStoredFile: false,
      fileExpiresAt: null,
    });
    await worker.run();
    const item = await list();
    expect(item).toMatchObject({
      storageStatus: 'available',
      hasStoredFile: true,
    });
    expect(typeof item?.fileExpiresAt).toBe('string');
    expect(JSON.stringify(item)).not.toContain(key);
    expect(Object.keys(item ?? {})).not.toContain('storedFileKey');
  });
});

describe('retention, expiry and user deletion (spec 2.4 §1.3.5)', () => {
  it('an expired file is deleted from storage and its fields cleared; the row stays', async () => {
    const { id } = await saved(member);
    const key = (await row(id))?.stored_file_key as string;
    await db.query(
      `UPDATE transformations SET stored_file_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await app.get(TransformationRetention).run();
    expect(await objects()).not.toContain(key);
    expect(await row(id)).toMatchObject({
      storage_status: 'not_requested',
      stored_file_key: null,
      stored_file_until: null,
    });
    expect((await download(member, id)).statusCode).toBe(404);
  });

  it('old history rows lose their object first, and the row goes with it', async () => {
    const { id } = await saved(member);
    const key = (await row(id))?.stored_file_key as string;
    await db.query(
      `UPDATE transformations SET created_at = now() - interval '91 days' WHERE id = $1`,
      [id],
    );
    await app.get(TransformationRetention).run();
    expect(await objects()).not.toContain(key);
    expect(await row(id)).toBeUndefined();
  });

  it('a row stays while its object cannot be deleted, and goes on the next sweep', async () => {
    const { id } = await saved(member);
    await db.query(
      `UPDATE transformations SET created_at = now() - interval '91 days' WHERE id = $1`,
      [id],
    );
    const spy = jest
      .spyOn(app.get(ObjectStorage), 'delete')
      .mockResolvedValue('unavailable');
    await app.get(TransformationRetention).run();
    expect(await row(id)).toBeDefined();
    spy.mockRestore();
    await app.get(TransformationRetention).run();
    expect(await row(id)).toBeUndefined();
  });

  it('a missing object counts as deleted', async () => {
    const { id } = await saved(member);
    const key = (await row(id))?.stored_file_key as string;
    await rm(join(store, key));
    await db.query(
      `UPDATE transformations SET created_at = now() - interval '91 days' WHERE id = $1`,
      [id],
    );
    await app.get(TransformationRetention).run();
    expect(await row(id)).toBeUndefined();
  });

  it("the user-deletion eraser removes the user's objects, copies and rows", async () => {
    const victim = await actorWithRoles(app, ['user']);
    const { id } = await saved(victim);
    const pending = await convert(victim, { save: 'true' });
    const pendingKey = (
      await row(pending.headers['x-transformation-id'] as string)
    )?.stored_file_key as string;
    const key = (await row(id))?.stored_file_key as string;
    const eraser = app.get(TransformationsEraser);
    expect(await eraser.eraseUserData(victim.id)).toEqual({
      result: 'succeeded',
    });
    expect(await objects()).not.toContain(key);
    expect(await pendingCopies()).not.toContain(pendingKey);
    expect(await row(id)).toBeUndefined();
    // Idempotent.
    expect(await eraser.eraseUserData(victim.id)).toEqual({
      result: 'succeeded',
    });
  });

  it('the eraser asks for a retry while storage is unavailable, and keeps the rows', async () => {
    const victim = await actorWithRoles(app, ['user']);
    const { id } = await saved(victim);
    jest
      .spyOn(app.get(ObjectStorage), 'delete')
      .mockResolvedValue('unavailable');
    const eraser = app.get(TransformationsEraser);
    expect(await eraser.eraseUserData(victim.id)).toMatchObject({
      result: 'retryable_failure',
    });
    expect(await row(id)).toBeDefined();
  });
});

describe('logging (spec 2.4 §1.5)', () => {
  it('logs save and download with ids, size and result, and no key, name or content', async () => {
    logs.clear();
    const { id } = await saved(member, 'private words');
    const key = (await row(id))?.stored_file_key as string;
    await download(member, id);
    const events = logs
      .lines()
      .filter((line) => line.event === 'transformation_storage');
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['save', 'download']),
    );
    for (const event of events)
      expect(event).toMatchObject({
        transformationId: id,
        userId: member.id,
        result: expect.any(String) as string,
        durationMs: expect.any(Number) as number,
      });
    for (const secret of [
      key,
      'private words',
      'PRIVATE WORDS',
      'report.probe',
    ])
      expect(logs.text()).not.toContain(secret);
    sensitive.push(key);
  });
});

describe('temporary area', () => {
  it('stays private: the pending directory holds only 32-hex names, mode 0700', async () => {
    await convert(member, { save: 'true' });
    for (const name of await pendingCopies())
      expect(name).toMatch(/^[0-9a-f]{32}$/);
    expect((await stat(join(temp, 'pending'))).mode & 0o777).toBe(0o700);
  });
});
