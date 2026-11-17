import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import sharp from 'sharp';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import type { SafeProfile } from '@/modules/users/safe-profile';
import { USER_STATUSES } from '@/modules/users/users.types';
import {
  ObjectStorage,
  STORAGE_ADOPTION_LOCK,
} from '@/modules/storage/object-storage';
import { StorageCleanup } from '@/modules/storage/storage-cleanup.service';
import {
  assertRbacManagerRemains,
  lockRbacPolicy,
} from '@/modules/rbac/rbac-invariant';

import { codeFrom, createUser, ip, setStatus, tokenFrom } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { waitForMail, waitForMailCount } from './utils/mailpit';
import { resetRateLimits } from './utils/rate-limits';
import { type Actor, actorWithRoles, ensureBootstrapped } from './utils/rbac';

const logs = new LogCapture();
const sensitive: string[] = [];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let root: string;
let admin: Actor;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c13-e2e-'));
  ({ app, config } = await createTestApp({
    logs,
    env: { STORAGE_LOCAL_ROOT: root },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  admin = await actorWithRoles(app, ['admin']);
});
beforeEach(async () => resetRateLimits(app));
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const email = () => `update-${randomUUID()}@example.com`;
async function call(
  method: 'PATCH' | 'POST' | 'PUT' | 'DELETE' | 'GET',
  path: string,
  actor?: Actor,
  body?: unknown,
) {
  return app.inject({
    method,
    url: path,
    cookies: actor?.cookies,
    payload: body as Record<string, unknown>,
    remoteAddress: ip(),
  });
}
const patch = (actor: Actor, target: string, body: unknown) =>
  call('PATCH', `/users/${target}`, actor, body);
const start = (actor: Actor, newEmail: string) =>
  call('POST', `/users/${actor.id}/email-change`, actor, { newEmail });
const confirm = (actor: Actor, challengeId: string, code: string) =>
  call('POST', `/users/${actor.id}/email-change/confirm`, actor, {
    challengeId,
    code,
  });
const profileFields = [
  'id',
  'email',
  'displayName',
  'photoUrl',
  'status',
  'createdAt',
  'updatedAt',
].sort();

async function begin(actor: Actor, address = email()) {
  const res = await start(actor, address);
  expect(res.statusCode).toBe(202);
  const { challengeId } = res.json<{ challengeId: string }>();
  const mail = await waitForMail(address);
  const code = codeFrom(mail.text);
  sensitive.push(address, code, tokenFrom(mail.text));
  return { challengeId, code, address };
}

describe('profile PATCH (spec 1.5)', () => {
  it('protects the last active manager using the real shared invariant without changing global fixtures', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await lockRbacPolicy(runner.manager);
      await runner.query(
        `UPDATE users SET status = 'blocked' WHERE status = 'active' AND id <> $1`,
        [admin.id],
      );
      await assertRbacManagerRemains(runner.manager);
      await runner.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [
        admin.id,
      ]);
      await expect(
        assertRbacManagerRemains(runner.manager),
      ).rejects.toMatchObject({ code: 'last_rbac_manager' });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  it('checks session/base rights, then foreign/admin-field rights before lookup', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const noRights = await actorWithRoles(app, []);
    const url = `/users/${randomUUID()}`;
    expect(
      (await call('PATCH', url, undefined, { displayName: 'Name' })).statusCode,
    ).toBe(401);
    expect(
      (await patch(noRights, noRights.id, { displayName: 'Name' })).statusCode,
    ).toBe(403);
    expect(
      (await patch(actor, randomUUID(), { displayName: 'Name' })).statusCode,
    ).toBe(403);
    for (const body of [{ email: email() }, { status: 'blocked' }])
      expect((await patch(actor, actor.id, body)).statusCode).toBe(403);
    expect(
      (await patch(admin, 'absent-id', { displayName: 'Name' })).statusCode,
    ).toBe(404);
  });

  it('normalizes displayName, clears with null, and leaves updatedAt unchanged for a no-op', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const first = await patch(actor, actor.id.toUpperCase(), {
      displayName: '  E\u0301va  ',
    });
    expect(first.statusCode).toBe(200);
    expect(Object.keys(first.json()).sort()).toEqual(profileFields);
    const saved = first.json<SafeProfile>();
    expect(saved.displayName).toBe('Éva');
    const same = await patch(actor, actor.id, { displayName: 'Éva' });
    expect(same.json<SafeProfile>().updatedAt).toBe(saved.updatedAt);
    expect(
      (await patch(actor, actor.id, { displayName: null })).json<SafeProfile>()
        .displayName,
    ).toBeNull();
    sensitive.push('Éva', actor.email);
  });

  it.each([
    {},
    { roles: [] },
    { password: 'secret' },
    { photoUrl: 'url' },
    { displayName: ' ' },
    { displayName: 'a\u0000' },
    { displayName: 'a'.repeat(81) },
    { email: null },
    { status: 'deleted' },
  ])('rejects malformed fields %j', async (body) => {
    expect((await patch(admin, admin.id, body)).statusCode).toBe(400);
  });

  it('rejects duplicate JSON keys, including escaped aliases', async () => {
    for (const payload of [
      '{"displayName":"a","displayName":"b"}',
      '{"email":"a@example.com","\\u0065mail":"b@example.com"}',
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${admin.id}`,
        cookies: admin.cookies,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it.each(['pending', 'deleting', 'deleted'])(
    'refuses a %s target',
    async (status) => {
      const user = await createUser(app);
      await setStatus(app, user.id, status);
      expect(
        (await patch(admin, user.id, { displayName: 'Name' })).statusCode,
      ).toBe(409);
    },
  );

  it('serializes a unique-email race: exactly one update wins', async () => {
    const a = await createUser(app);
    const b = await createUser(app);
    const address = email();
    const res = await Promise.all([
      patch(admin, a.id, { email: address }),
      patch(admin, b.id, { email: address }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const [{ count }] = await db.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM users WHERE email = $1`,
      [address],
    );
    expect(count).toBe(1);
    sensitive.push(address);
  });

  it('blocks/unblocks a target, invalidates challenges and stops the same access token', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    expect(
      (await patch(admin, actor.id, { status: 'blocked' })).statusCode,
    ).toBe(200);
    expect((await call('GET', `/users/${actor.id}`, actor)).statusCode).toBe(
      401,
    );
    const [challenge] = await db.query<{ consumed_reason: string }[]>(
      `SELECT consumed_reason FROM email_change_challenges WHERE id = $1`,
      [attempt.challengeId],
    );
    expect(challenge.consumed_reason).toBe('user_inactive');
    expect(
      (await patch(admin, actor.id, { status: 'active' })).statusCode,
    ).toBe(200);
    expect((await call('GET', `/users/${actor.id}`, actor)).statusCode).toBe(
      200,
    );
  });
});

describe('email change (spec 1.5)', () => {
  it('timestamps a transactional email quota after earlier user-lock work, not at transaction start', async () => {
    await db.transaction(async (manager) => {
      await manager.query('SELECT pg_sleep(0.025)');
      await app
        .get<RateLimiter>(RateLimiter)
        .consume('email_change_emails', [randomUUID()], manager);
      const [{ valid }] = await manager.query<{ valid: boolean }[]>(
        `SELECT bool_and(hits[cardinality(hits)] > transaction_timestamp()) AS valid FROM rate_limits WHERE xmin::text = pg_current_xact_id()::text AND bucket = 'email_change_emails'`,
      );
      expect(valid).toBe(true);
    });
  });
  it('allows at most five issued emails per hour and rolls back a quota-refused replacement', async () => {
    const actor = await actorWithRoles(app, ['user']);
    let last = '';
    for (let n = 0; n < 5; n++) {
      const attempt = await begin(actor);
      last = attempt.challengeId;
      await db.query(
        `UPDATE email_change_challenges SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
        [last],
      );
    }
    expect((await start(actor, email())).statusCode).toBe(429);
    const rows = await db.query<{ id: string }[]>(
      `SELECT id FROM email_change_challenges WHERE user_id = $1 AND consumed_at IS NULL`,
      [actor.id],
    );
    expect(rows).toEqual([{ id: last }]);
  });

  it('allows only one concurrent confirmation and keeps the other request unambiguous', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    const results = await Promise.all([
      confirm(actor, attempt.challengeId, attempt.code),
      confirm(actor, attempt.challengeId, attempt.code),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it('supports a magic link while requiring the same active session', async () => {
    const other = await createTestApp({
      logs,
      env: { EMAIL_CHANGE_METHOD: 'magic_link', STORAGE_LOCAL_ROOT: root },
    });
    try {
      const actor = await actorWithRoles(other.app, ['user']);
      const address = email();
      const started = await other.app.inject({
        method: 'POST',
        url: `/users/${actor.id}/email-change`,
        cookies: actor.cookies,
        payload: { newEmail: address },
      });
      expect(started.statusCode).toBe(202);
      const token = tokenFrom((await waitForMail(address)).text);
      sensitive.push(token, address);
      const url = `/users/${actor.id}/email-change/confirm`;
      expect(
        (await other.app.inject({ method: 'POST', url, payload: { token } }))
          .statusCode,
      ).toBe(401);
      const res = await other.app.inject({
        method: 'POST',
        url,
        cookies: actor.cookies,
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<SafeProfile>().email).toBe(address);
    } finally {
      await other.app.close();
    }
  });

  it('keeps a committed challenge on SMTP failure with safe recovery fields', async () => {
    const other = await createTestApp({
      logs,
      env: { SMTP_PORT: '1', STORAGE_LOCAL_ROOT: root },
    });
    try {
      const actor = await actorWithRoles(other.app, ['user']);
      const address = email();
      sensitive.push(address);
      const res = await other.app.inject({
        method: 'POST',
        url: `/users/${actor.id}/email-change`,
        cookies: actor.cookies,
        payload: { newEmail: address },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json<{
        challengeId: string;
        confirmationRequired: boolean;
        method: string;
        retryAfterSeconds: number;
      }>();
      expect(body).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        retryAfterSeconds: 60,
      });
      const [challenge] = await db.query<{ consumed_at: Date | null }[]>(
        `SELECT consumed_at FROM email_change_challenges WHERE id = $1`,
        [body.challengeId],
      );
      expect(challenge.consumed_at).toBeNull();
      expect(res.body).not.toContain(address);
    } finally {
      await other.app.close();
    }
  });
  it('is self-only even for admin and refuses current/occupied emails', async () => {
    const actor = await actorWithRoles(app, ['user']);
    expect(
      (
        await call('POST', `/users/${actor.id}/email-change`, admin, {
          newEmail: email(),
        })
      ).statusCode,
    ).toBe(403);
    expect((await start(actor, actor.email)).statusCode).toBe(409);
    expect((await start(actor, admin.email)).statusCode).toBe(409);
  });

  it('commits wrong attempts, accepts the fifth valid code and rejects reuse', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    const wrong = attempt.code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 4; n++)
      expect(
        (await confirm(actor, attempt.challengeId, wrong)).statusCode,
      ).toBe(400);
    const res = await confirm(actor, attempt.challengeId, attempt.code);
    expect(res.statusCode).toBe(200);
    expect(res.json<SafeProfile>().email).toBe(attempt.address);
    expect(Object.keys(res.json()).sort()).toEqual(profileFields);
    expect(
      (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
    ).toBe(400);
  });

  it('exhausts a fifth wrong OTP and expires without incrementing attempts', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    const wrong = attempt.code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++)
      expect(
        (await confirm(actor, attempt.challengeId, wrong)).statusCode,
      ).toBe(400);
    expect(
      (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
    ).toBe(429);
    const other = await actorWithRoles(app, ['user']);
    const expired = await begin(other);
    await db.query(
      `UPDATE email_change_challenges SET last_sent_at = now() - interval '10 minutes' WHERE id = $1`,
      [expired.challengeId],
    );
    expect(
      (await confirm(other, expired.challengeId, expired.code)).statusCode,
    ).toBe(400);
    const [row] = await db.query<{ attempts: number }[]>(
      `SELECT attempts FROM email_change_challenges WHERE id = $1`,
      [expired.challengeId],
    );
    expect(row.attempts).toBe(0);
  });

  it('resends after cooldown, replaces the secret and retains method/address', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    const resend = () =>
      call('POST', `/users/${actor.id}/email-change/resend`, actor, {
        challengeId: attempt.challengeId,
      });
    expect((await resend()).statusCode).toBe(429);
    await db.query(
      `UPDATE email_change_challenges SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
      [attempt.challengeId],
    );
    expect((await resend()).statusCode).toBe(202);
    const mail = await waitForMailCount(attempt.address, 2);
    const code = codeFrom(mail.text);
    sensitive.push(code);
    if (code !== attempt.code)
      expect(
        (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
      ).toBe(400);
    expect((await confirm(actor, attempt.challengeId, code)).statusCode).toBe(
      200,
    );
  });

  it('commits email_conflict when the address is occupied after issue', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    await createUser(app, { email: attempt.address });
    expect(
      (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
    ).toBe(409);
    const [row] = await db.query<{ consumed_reason: string }[]>(
      `SELECT consumed_reason FROM email_change_challenges WHERE id = $1`,
      [attempt.challengeId],
    );
    expect(row.consumed_reason).toBe('email_conflict');
    expect(
      (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
    ).toBe(409);
  });

  it('admin direct email changes consume the pending self challenge', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const attempt = await begin(actor);
    const address = email();
    sensitive.push(address);
    expect((await patch(admin, actor.id, { email: address })).statusCode).toBe(
      200,
    );
    expect(
      (await confirm(actor, attempt.challengeId, attempt.code)).statusCode,
    ).toBe(409);
    const [row] = await db.query<{ consumed_reason: string }[]>(
      `SELECT consumed_reason FROM email_change_challenges WHERE id = $1`,
      [attempt.challengeId],
    );
    expect(row.consumed_reason).toBe('admin_override');
  });
});

function multipart(parts: { name: string; mime?: string; bytes: Buffer }[]) {
  const boundary = `c13-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.mime ? '; filename="private-original.jpg"' : ''}\r\n${part.mime ? `Content-Type: ${part.mime}\r\n` : ''}\r\n`,
      ),
      part.bytes,
      Buffer.from('\r\n'),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, bytes: Buffer.concat(chunks) };
}
async function upload(
  actor: Actor,
  target: string,
  parts: { name: string; mime?: string; bytes: Buffer }[],
) {
  const body = multipart(parts);
  return app.inject({
    method: 'PUT',
    url: `/users/${target}/photo`,
    cookies: actor.cookies,
    headers: {
      'content-type': `multipart/form-data; boundary=${body.boundary}`,
    },
    payload: body.bytes,
    remoteAddress: ip(),
  });
}
const image = () =>
  sharp({ create: { width: 128, height: 64, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();

describe('photos and cleanup (spec 1.5)', () => {
  it('normalizes, serves, replaces and clears a photo; no-op clear retains updatedAt', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const bytes = await image();
    const keys: string[] = [];
    for (let n = 0; n < 2; n++) {
      const res = await upload(actor, actor.id, [
        { name: 'file', mime: 'image/png', bytes },
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json<SafeProfile>().photoUrl).toContain(
        `/users/${actor.id}/photo`,
      );
      const photo = await call('GET', `/users/${actor.id}/photo`, actor);
      expect(photo.statusCode).toBe(200);
      const [stored] = await db.query<{ photo_key: string }[]>(
        `SELECT photo_key FROM users WHERE id = $1`,
        [actor.id],
      );
      keys.push(stored.photo_key);
      sensitive.push(stored.photo_key);
      expect((await sharp(photo.rawPayload).metadata()).format).toBe('webp');
    }
    expect(
      (await call('DELETE', `/users/${actor.id}/photo`, actor)).statusCode,
    ).toBe(204);
    const before = await call('GET', `/users/${actor.id}`, actor);
    expect(
      (await call('DELETE', `/users/${actor.id}/photo`, actor)).statusCode,
    ).toBe(204);
    const after = await call('GET', `/users/${actor.id}`, actor);
    expect(after.json<SafeProfile>().updatedAt).toBe(
      before.json<SafeProfile>().updatedAt,
    );
    expect(after.json<SafeProfile>().photoUrl).toBeNull();
    const jobs = await db.query<{ reason: string }[]>(
      `SELECT reason FROM storage_cleanup_jobs WHERE storage_key = ANY($1::text[]) ORDER BY created_at, id`,
      [keys],
    );
    expect(jobs.map((j) => j.reason).sort()).toEqual([
      'photo_cleared',
      'photo_replaced',
    ]);
    sensitive.push('private-original.jpg');
  });

  it('preserves the old profile on storage failure and deletes a new object after a status race', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const bytes = await image();
    const storage = app.get<ObjectStorage>(ObjectStorage);
    const failing = jest
      .spyOn(storage, 'write')
      .mockResolvedValue('unavailable');
    expect(
      (
        await upload(actor, actor.id, [
          { name: 'file', mime: 'image/png', bytes },
        ])
      ).statusCode,
    ).toBe(503);
    expect(
      (await call('GET', `/users/${actor.id}`, actor)).json<SafeProfile>()
        .photoUrl,
    ).toBeNull();
    failing.mockRestore();
    const original = storage.write.bind(storage) as ObjectStorage['write'];
    let key = '';
    jest.spyOn(storage, 'write').mockImplementation(async (newKey, data) => {
      key = newKey;
      const result = await original(newKey, data);
      await db.query(`UPDATE users SET status = 'deleting' WHERE id = $1`, [
        actor.id,
      ]);
      return result;
    });
    expect(
      (
        await upload(actor, actor.id, [
          { name: 'file', mime: 'image/png', bytes },
        ])
      ).statusCode,
    ).toBe(409);
    expect(await storage.read(key)).toEqual({ kind: 'not_found' });
    sensitive.push(key);
  });

  it('retries cleanup five times and treats a missing object as successful', async () => {
    const key = `${randomUUID()}.webp`;
    sensitive.push(key);
    const [job] = await db.query<{ id: string }[]>(
      `INSERT INTO storage_cleanup_jobs (storage_key, reason, next_attempt_at) VALUES ($1, 'photo_cleared', '1970-01-01') RETURNING id`,
      [key],
    );
    const remove = jest
      .spyOn(app.get<ObjectStorage>(ObjectStorage), 'delete')
      .mockResolvedValue('unavailable');
    const worker = app.get<StorageCleanup>(StorageCleanup);
    for (let n = 1; n <= 5; n++) {
      await worker.run();
      const [row] = await db.query<
        {
          status: string;
          attempts: number;
          updated_at: Date;
          next_attempt_at: Date | null;
        }[]
      >(
        `SELECT status, attempts, next_attempt_at, updated_at FROM storage_cleanup_jobs WHERE id = $1`,
        [job.id],
      );
      expect(row.attempts).toBe(n);
      expect(row.status).toBe(n === 5 ? 'failed' : 'queued');
      if (n < 5) {
        expect(
          Math.abs(
            row.next_attempt_at!.getTime() - row.updated_at.getTime() - 60_000,
          ),
        ).toBeLessThanOrEqual(1);
        await db.query(
          `UPDATE storage_cleanup_jobs SET next_attempt_at = '1970-01-01' WHERE id = $1`,
          [job.id],
        );
      }
    }
    remove.mockRestore();
    const [missing] = await db.query<{ id: string }[]>(
      `INSERT INTO storage_cleanup_jobs (storage_key, reason, next_attempt_at) VALUES ($1, 'photo_cleared', '1970-01-01') RETURNING id`,
      [`${randomUUID()}.webp`],
    );
    await worker.run();
    const [finished] = await db.query<{ status: string }[]>(
      `SELECT status FROM storage_cleanup_jobs WHERE id = $1`,
      [missing.id],
    );
    expect(finished.status).toBe('succeeded');
  });

  it('reconciliation cannot race a pending photo adoption', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('SELECT pg_advisory_xact_lock_shared($1)', [
        STORAGE_ADOPTION_LOCK,
      ]);
      expect(await app.get<StorageCleanup>(StorageCleanup).sweep()).toBe(0);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('reconciles only old unreferenced photo objects and preserves current references', async () => {
    const storage = app.get<ObjectStorage>(ObjectStorage);
    const worker = app.get<StorageCleanup>(StorageCleanup);
    const old = `${randomUUID()}.webp`;
    const live = `${randomUUID()}.webp`;
    const recent = `${randomUUID()}.webp`;
    sensitive.push(old, live, recent);
    for (const key of [old, live, recent])
      expect(await storage.write(key, Buffer.from('test object'))).toBe(
        'stored',
      );
    const [{ old_time, current_time }] = await db.query<
      { old_time: Date; current_time: Date }[]
    >(
      `SELECT clock_timestamp() - interval '2 hours' AS old_time, clock_timestamp() AS current_time`,
    );
    for (const key of [old, live])
      await utimes(join(root, key), old_time, old_time);
    await utimes(join(root, recent), current_time, current_time);
    const owner = await createUser(app);
    await db.query(`UPDATE users SET photo_key = $2 WHERE id = $1`, [
      owner.id,
      live,
    ]);
    expect(await worker.sweep()).toBe(1);
    expect(await storage.read(old)).toEqual({ kind: 'not_found' });
    for (const key of [live, recent]) {
      const object = await storage.read(key);
      expect(object.kind).toBe('found');
      if (object.kind === 'found') object.stream.destroy();
    }
  });

  it('shares a 30/hour budget between PATCH and photo operations and applies CSRF', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const cross = await app.inject({
      method: 'PATCH',
      url: `/users/${actor.id}`,
      cookies: actor.cookies,
      headers: { origin: 'https://evil.example' },
      payload: { displayName: 'Name' },
    });
    expect(cross.statusCode).toBe(403);
    for (let n = 0; n < 30; n++)
      expect(
        (n % 2
          ? await call('DELETE', `/users/${actor.id}/photo`, actor)
          : await patch(actor, actor.id, { displayName: null })
        ).statusCode,
      ).toBe(n % 2 ? 204 : 200);
    expect(
      (await patch(actor, actor.id, { displayName: null })).statusCode,
    ).toBe(429);
  });

  it('checks foreign rights before target lookup and refuses noneditable statuses', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const bytes = await image();
    expect(
      (
        await upload(actor, randomUUID(), [
          { name: 'file', mime: 'image/png', bytes },
        ])
      ).statusCode,
    ).toBe(403);
    for (const status of USER_STATUSES.filter(
      (s) => !['active', 'blocked'].includes(s),
    )) {
      const user = await createUser(app);
      await setStatus(app, user.id, status);
      expect(
        (
          await upload(admin, user.id, [
            { name: 'file', mime: 'image/png', bytes },
          ])
        ).statusCode,
      ).toBe(409);
    }
  });

  it('rejects extra fields/files, unsupported MIME, corrupt content and oversize files', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const bytes = await image();
    const valid = { name: 'file', mime: 'image/png', bytes };
    for (const parts of [
      [valid, valid],
      [valid, { name: 'extra', bytes: Buffer.from('value') }],
      [{ ...valid, name: 'wrong' }],
    ])
      expect((await upload(actor, actor.id, parts)).statusCode).toBe(400);
    expect(
      (await upload(actor, actor.id, [{ ...valid, mime: 'image/jpeg' }]))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await upload(actor, actor.id, [
          { ...valid, bytes: bytes.subarray(0, 20) },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await upload(actor, actor.id, [
          { ...valid, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) },
        ])
      ).statusCode,
    ).toBe(413);
  });
});
