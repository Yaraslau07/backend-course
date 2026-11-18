import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { DeletionWorker } from '@/modules/users/deletion-worker.service';
import { HOLDER_REMAINS } from '@/modules/rbac/rbac-invariant';

import {
  codeFrom,
  createUser,
  ip,
  parseSetCookies,
  PASSWORD,
  setStatus,
  tokenFrom,
} from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { EraserProbeModule, ProbeEraser } from './utils/eraser-probe.module';
import { LogCapture } from './utils/log-capture';
import { waitForMail, waitForMailCount } from './utils/mailpit';
import { resetRateLimits } from './utils/rate-limits';
import {
  type Actor,
  actorWithRoles,
  ensureBootstrapped,
  roleId,
  uniqueName,
} from './utils/rbac';

const logs = new LogCapture();
/** Everything spec 1.6 §1.5 keeps out of the logs: ids, keys, emails, secrets, tombstones. */
const sensitive: string[] = [];
/**
 * Requests to routes outside spec 1.6 (profile read, role assignment, registration). Those may log
 * user ids under their own specs, so only their lines are exempt from the id check.
 */
const otherRoutes = new Set<string>();
const outsideDeletion = <T extends { headers: Record<string, unknown> }>(
  res: T,
): T => {
  otherRoutes.add(String(res.headers['x-request-id']));
  return res;
};
const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let root: string;
let admin: Actor;
let probe: ProbeEraser;
let worker: DeletionWorker;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c14-e2e-'));
  ({ app, config } = await createTestApp({
    logs,
    imports: [EraserProbeModule],
    env: { STORAGE_LOCAL_ROOT: root },
  }));
  db = app.get(DataSource);
  probe = app.get(ProbeEraser);
  worker = app.get(DeletionWorker);
  await ensureBootstrapped(app);
  admin = await actorWithRoles(app, ['admin']);
  sensitive.push(admin.id);
});
beforeEach(async () => {
  await resetRateLimits(app);
  probe.next = { result: 'succeeded' };
});
afterAll(async () => {
  logs.expectNoLeaks(
    config,
    sensitive.filter((value) => !UUID_VALUE.test(value)),
  );
  const ids = sensitive.filter((value) => UUID_VALUE.test(value));
  const leaking = logs
    .lines()
    .filter(
      (line) => !otherRoutes.has(String((line.req as { id?: string })?.id)),
    )
    .filter((line) => ids.some((id) => JSON.stringify(line).includes(id)));
  // Only the count and events, never the values themselves.
  expect(leaking.map((line) => line.event)).toEqual([]);
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const newKey = () => {
  const key = randomBytes(16).toString('hex');
  sensitive.push(key);
  return key;
};

/** A new active user with the `user` role (users@read, update, delete), tracked as sensitive. */
async function member(): Promise<Actor> {
  const actor = await actorWithRoles(app, ['user']);
  sensitive.push(actor.id, actor.email);
  return actor;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  options: {
    actor?: Actor;
    body?: unknown;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
) {
  return app.inject({
    method,
    url,
    cookies: options.actor?.cookies,
    headers: options.headers,
    ...(options.body === undefined
      ? {}
      : { payload: options.body as Record<string, unknown> }),
    remoteAddress: options.remoteAddress ?? ip(),
  });
}

const startChallenge = (actor: Actor, target = actor.id) =>
  call('POST', `/users/${target}/deletion-challenge`, { actor });
const resend = (actor: Actor, challengeId: string) =>
  call('POST', `/users/${actor.id}/deletion-challenge/resend`, {
    actor,
    body: { challengeId },
  });
const confirm = (
  actor: Actor | undefined,
  target: string,
  key: string | undefined,
  body: unknown,
) =>
  call('POST', `/users/${target}/deletion-confirm`, {
    actor,
    body,
    headers: key === undefined ? {} : { 'idempotency-key': key },
  });
const adminDelete = (actor: Actor, target: string, key?: string) =>
  call('DELETE', `/users/${target}`, {
    actor,
    headers: key === undefined ? {} : { 'idempotency-key': key },
  });
const statusByReceipt = (target: string, receipt: string, actor?: Actor) =>
  call('GET', `/users/${target}/deletion-status`, {
    actor,
    headers: { 'deletion-receipt': receipt },
  });
const statusAsAdmin = (actor: Actor, target: string) =>
  call('GET', `/users/${target}/deletion-status`, { actor });

/** Starts a challenge and reads its OTP from Mailpit. */
async function challenge(actor: Actor) {
  const res = await startChallenge(actor);
  expect(res.statusCode).toBe(202);
  const { challengeId } = res.json<{ challengeId: string }>();
  const mail = await waitForMail(actor.email);
  const code = codeFrom(mail.text);
  sensitive.push(code, tokenFrom(mail.text), challengeId);
  return { challengeId, code };
}

async function selfDelete(actor: Actor, key = newKey()) {
  const { challengeId, code } = await challenge(actor);
  const res = await confirm(actor, actor.id, key, { challengeId, code });
  expect(res.statusCode).toBe(202);
  return { key, res };
}

async function user(id: string) {
  const [row] = await db.query<
    {
      email: string;
      display_name: string | null;
      photo_key: string | null;
      password_hash: string | null;
      status: string;
    }[]
  >(
    `SELECT email, display_name, photo_key, password_hash, status FROM users WHERE id = $1`,
    [id],
  );
  return row;
}
async function job(id: string) {
  const [row] = await db.query<
    {
      id: string;
      user_id: string;
      status: string;
      attempts: number;
      lease_until: Date | null;
      next_attempt_at: Date | null;
      tombstone_email: string;
      last_error_code: string | null;
      finished_at: Date | null;
    }[]
  >(`SELECT * FROM deletion_jobs WHERE id = $1`, [id]);
  if (row) sensitive.push(row.tombstone_email);
  return row;
}
const roleCount = async (id: string) =>
  (
    await db.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1`,
      [id],
    )
  )[0].n;
/** Makes the worker see the job as due now (instead of waiting a minute between retries). */
const makeDue = (id: string) =>
  db.query(
    `UPDATE deletion_jobs SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1 AND status = 'queued'`,
    [id],
  );
/** Runs the worker until this job leaves `queued`/`running` (other suites' jobs may be due too). */
async function work(id: string) {
  for (let n = 0; n < 10; n++) {
    await makeDue(id);
    await worker.run();
    const current = await job(id);
    if (current.status !== 'queued' && current.status !== 'running')
      return current;
  }
  return job(id);
}

/**
 * Runs `work` while `keep` is the only active holder of rbac@manage. Other holders are blocked
 * for the duration and restored afterwards (the e2e run is serial, D22).
 */
async function asOnlyManager(keep: string, work: () => Promise<void>) {
  const holders = await db.query<{ id: string }[]>(
    `SELECT DISTINCT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN grants g ON g.role_id = ur.role_id
       JOIN permissions p ON p.id = g.permission_id AND p.name = 'rbac'
      WHERE u.status = 'active' AND u.id <> $1`,
    [keep],
  );
  const ids = holders.map((h) => h.id);
  await db.query(`UPDATE users SET status = 'blocked' WHERE id = ANY($1)`, [
    ids,
  ]);
  try {
    const [{ ok }] = await db.query<{ ok: boolean }[]>(HOLDER_REMAINS, [
      'rbac',
      'manage',
    ]);
    expect(ok).toBe(true);
    await work();
  } finally {
    await db.query(`UPDATE users SET status = 'active' WHERE id = ANY($1)`, [
      ids,
    ]);
  }
}

describe('self deletion challenge (spec 1.6 §1.3.1)', () => {
  it('202 with the challenge fields only, and the code mailed to the current email', async () => {
    const actor = await member();
    const res = await startChallenge(actor);
    expect(res.statusCode).toBe(202);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      [
        'challengeId',
        'confirmationRequired',
        'expiresInSeconds',
        'method',
        'resendAfterSeconds',
      ].sort(),
    );
    expect(body).toMatchObject({
      confirmationRequired: true,
      method: config.DELETION_CONFIRMATION_METHOD,
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
    const mail = await waitForMail(actor.email);
    expect(mail.subject).toBe('Confirm deleting your account');
    const code = codeFrom(mail.text);
    sensitive.push(code);
    expect(res.body).not.toContain(code);
    expect(res.body).not.toContain(actor.email);
  });

  it("someone else's id is 403 before any lookup, existing or not", async () => {
    const actor = await member();
    const other = await member();
    expect((await startChallenge(actor, other.id)).statusCode).toBe(403);
    expect((await startChallenge(actor, randomUUID())).statusCode).toBe(403);
  });

  it('401 without a session, 403 without users@delete, 400 with a body', async () => {
    const actor = await member();
    expect(
      (await call('POST', `/users/${actor.id}/deletion-challenge`)).statusCode,
    ).toBe(401);
    const reader = await actorWithRoles(app, []);
    sensitive.push(reader.id, reader.email);
    const denied = await startChallenge(reader);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'permission_denied' });
    const withBody = await call(
      'POST',
      `/users/${actor.id}/deletion-challenge`,
      { actor, body: { reason: 'x' } },
    );
    expect(withBody.statusCode).toBe(400);
  });

  it('a second challenge within 60 s is 429 with the remaining time; after it, the old one is replaced', async () => {
    const actor = await member();
    const first = await challenge(actor);
    const again = await startChallenge(actor);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: 'resend_cooldown' });
    expect(
      again.json<{ retryAfterSeconds: number }>().retryAfterSeconds,
    ).toBeGreaterThan(0);

    await db.query(
      `UPDATE deletion_challenges SET last_sent_at = last_sent_at - interval '61 seconds' WHERE user_id = $1`,
      [actor.id],
    );
    const second = await startChallenge(actor);
    expect(second.statusCode).toBe(202);
    const [old] = await db.query<{ consumed_reason: string }[]>(
      `SELECT consumed_reason FROM deletion_challenges WHERE id = $1`,
      [first.challengeId],
    );
    expect(old.consumed_reason).toBe('replaced');
  });

  it('at most 5 challenge emails per user per hour, resends included', async () => {
    const actor = await member();
    const { challengeId } = await challenge(actor);
    const age = () =>
      db.query(
        `UPDATE deletion_challenges SET last_sent_at = last_sent_at - interval '61 seconds' WHERE user_id = $1`,
        [actor.id],
      );
    for (let n = 0; n < 4; n++) {
      await age();
      expect((await resend(actor, challengeId)).statusCode).toBe(202);
    }
    await age();
    const sixth = await resend(actor, challengeId);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ code: 'too_many_requests' });
    await waitForMailCount(actor.email, 5);
  });

  it('resend: unknown id 400, within 60 s 429, after it a new code that replaces the old', async () => {
    const actor = await member();
    expect((await resend(actor, randomUUID())).statusCode).toBe(400);
    const { challengeId, code } = await challenge(actor);
    expect((await resend(actor, challengeId)).statusCode).toBe(429);
    await db.query(
      `UPDATE deletion_challenges SET last_sent_at = last_sent_at - interval '61 seconds', attempts = 3 WHERE id = $1`,
      [challengeId],
    );
    const res = await resend(actor, challengeId);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ challengeId });
    await waitForMailCount(actor.email, 2);
    const fresh = codeFrom((await waitForMail(actor.email)).text);
    sensitive.push(fresh);
    const [row] = await db.query<{ attempts: number }[]>(
      `SELECT attempts FROM deletion_challenges WHERE id = $1`,
      [challengeId],
    );
    expect(row.attempts).toBe(0);
    if (fresh !== code) {
      const stale = await confirm(actor, actor.id, newKey(), {
        challengeId,
        code,
      });
      expect(stale.statusCode).toBe(400);
    }
  });
});

describe('self confirmation and acceptance (spec 1.6 §1.3.2)', () => {
  it('validates the Idempotency-Key and the body shape (400)', async () => {
    const actor = await member();
    const { challengeId, code } = await challenge(actor);
    for (const key of [
      undefined,
      '',
      'ABCDEF0123456789ABCDEF0123456789',
      'short',
    ]) {
      expect(
        (await confirm(actor, actor.id, key, { challengeId, code })).statusCode,
      ).toBe(400);
    }
    for (const body of [
      {},
      { challengeId },
      { challengeId, code: '12345' },
      { challengeId, code, token: 'x.y' },
    ]) {
      expect((await confirm(actor, actor.id, newKey(), body)).statusCode).toBe(
        400,
      );
    }
  });

  it('a wrong OTP is 400 and counted; the 5th wrong one consumes it; then 429', async () => {
    const actor = await member();
    const { challengeId, code } = await challenge(actor);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 1; n <= 5; n++) {
      const res = await confirm(actor, actor.id, newKey(), {
        challengeId,
        code: wrong,
      });
      expect(res.statusCode).toBe(400);
    }
    const after = await confirm(actor, actor.id, newKey(), {
      challengeId,
      code,
    });
    expect(after.statusCode).toBe(429);
    expect(after.json()).toMatchObject({ code: 'attempts_exhausted' });
    expect((await user(actor.id)).status).toBe('active');
  });

  it('the 5th attempt can still succeed', async () => {
    const actor = await member();
    const { challengeId, code } = await challenge(actor);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let n = 1; n <= 4; n++) {
      await confirm(actor, actor.id, newKey(), { challengeId, code: wrong });
    }
    const res = await confirm(actor, actor.id, newKey(), { challengeId, code });
    expect(res.statusCode).toBe(202);
  });

  it('accepts: 202 receipt, expired cookies, deleting, no roles, challenges consumed, job queued', async () => {
    const actor = await member();
    // An outstanding email change must be cleared by the acceptance too.
    await db.query(
      `INSERT INTO email_change_challenges (user_id, method, secret_hash, new_email, last_sent_at)
       VALUES ($1, 'otp', $2, $3, now())`,
      [actor.id, randomBytes(32), `new-${randomUUID()}@example.com`],
    );
    const { challengeId, code } = await challenge(actor);
    const key = newKey();
    const res = await confirm(actor, actor.id, key, { challengeId, code });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      jobId: key,
      status: 'queued',
      statusUrl: `/users/${actor.id}/deletion-status`,
    });
    const cookies = parseSetCookies(res.headers['set-cookie']);
    expect(cookies.get('access_token')?.attributes.get('max-age')).toBe('0');
    expect(cookies.get('refresh_token')?.attributes.get('max-age')).toBe('0');
    expect(cookies.get('refresh_token')?.attributes.get('path')).toBe(
      '/auth/refresh',
    );

    expect((await user(actor.id)).status).toBe('deleting');
    expect(await roleCount(actor.id)).toBe(0);
    const created = await job(key);
    expect(created).toMatchObject({
      user_id: actor.id,
      status: 'queued',
      attempts: 0,
      lease_until: null,
    });
    expect(created.tombstone_email).toMatch(
      /^deleted\.[0-9a-f]{32}@example\.invalid$/,
    );
    const outstanding = await db.query<{ n: number }[]>(
      `SELECT (SELECT count(*) FROM deletion_challenges WHERE user_id = $1 AND consumed_at IS NULL)
            + (SELECT count(*) FROM email_change_challenges WHERE user_id = $1 AND consumed_at IS NULL)
            + (SELECT count(*) FROM login_challenges WHERE user_id = $1 AND consumed_at IS NULL) AS n`,
      [actor.id],
    );
    expect(Number(outstanding[0].n)).toBe(0);
    const [used] = await db.query<{ consumed_reason: string }[]>(
      `SELECT consumed_reason FROM deletion_challenges WHERE id = $1`,
      [challengeId],
    );
    expect(used.consumed_reason).toBe('confirmed');

    // The old session no longer works (access and refresh need an active user).
    expect(
      outsideDeletion(await call('GET', `/users/${actor.id}`, { actor }))
        .statusCode,
    ).toBe(401);
    const profile = outsideDeletion(
      await call('GET', `/users/${actor.id}`, { actor: admin }),
    );
    expect(profile.json()).toMatchObject({
      status: 'deleting',
      photoUrl: null,
    });
  });

  it('a lost 202 is replayed without a session; the same key for another target is 409', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    const replay = await confirm(undefined, actor.id, key, {
      challengeId: randomUUID(),
      code: '123456',
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({
      jobId: key,
      status: 'queued',
      statusUrl: `/users/${actor.id}/deletion-status`,
    });
    const other = await member();
    const conflict = await confirm(other, other.id, key, {
      challengeId: randomUUID(),
      code: '123456',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(
      await db.query(
        `SELECT 1 FROM deletion_jobs WHERE id = $1 AND user_id = $2`,
        [key, other.id],
      ),
    ).toHaveLength(0);
  });

  it("confirming someone else's id is 403", async () => {
    const actor = await member();
    const other = await member();
    const res = await confirm(actor, other.id, newKey(), {
      challengeId: randomUUID(),
      code: '123456',
    });
    expect(res.statusCode).toBe(403);
  });

  it('a challenge after an accepted deletion: the session is gone (401)', async () => {
    const actor = await member();
    await selfDelete(actor);
    expect((await startChallenge(actor)).statusCode).toBe(401);
  });

  it('the only active rbac@manage holder cannot delete themselves (409), and nothing changes', async () => {
    const manager = await actorWithRoles(app, ['admin']);
    sensitive.push(manager.id, manager.email);
    await asOnlyManager(manager.id, async () => {
      const { challengeId, code } = await challenge(manager);
      const key = newKey();
      const res = await confirm(manager, manager.id, key, {
        challengeId,
        code,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'last_rbac_manager' });
      expect(await job(key)).toBeUndefined();
      expect((await user(manager.id)).status).toBe('active');
      expect(await roleCount(manager.id)).toBeGreaterThan(0);
      const [row] = await db.query<{ consumed_at: Date | null }[]>(
        `SELECT consumed_at FROM deletion_challenges WHERE id = $1`,
        [challengeId],
      );
      expect(row.consumed_at).toBeNull();
    });
  });

  it('a manager with another active manager left can delete themselves', async () => {
    const manager = await actorWithRoles(app, ['admin']);
    sensitive.push(manager.id, manager.email);
    await selfDelete(manager);
    expect((await user(manager.id)).status).toBe('deleting');
  });
});

describe('admin deletion (spec 1.6 §1.3.3)', () => {
  it('own id is 403 self_confirmation_required', async () => {
    const res = await adminDelete(admin, admin.id, newKey());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'self_confirmation_required' });
  });

  it("without users@delete_any someone else's id is 403, whether it exists or not", async () => {
    const actor = await member();
    const other = await member();
    expect((await adminDelete(actor, other.id, newKey())).statusCode).toBe(403);
    expect((await adminDelete(actor, randomUUID(), newKey())).statusCode).toBe(
      403,
    );
    expect((await user(other.id)).status).toBe('active');
  });

  it('400 for a missing or malformed key or a body; 404 for an unknown target after permissions', async () => {
    const target = await member();
    expect((await adminDelete(admin, target.id)).statusCode).toBe(400);
    expect((await adminDelete(admin, target.id, 'nope')).statusCode).toBe(400);
    const withBody = await call('DELETE', `/users/${target.id}`, {
      actor: admin,
      headers: { 'idempotency-key': newKey() },
      body: { x: 1 },
    });
    expect(withBody.statusCode).toBe(400);
    expect((await adminDelete(admin, randomUUID(), newKey())).statusCode).toBe(
      404,
    );
    expect((await adminDelete(admin, 'not-a-uuid', newKey())).statusCode).toBe(
      404,
    );
    expect((await adminDelete(admin, 'bad id!', newKey())).statusCode).toBe(
      400,
    );
  });

  it('accepts without an email: 202, deleting, roles removed; repeats return the same job', async () => {
    const target = await member();
    const key = newKey();
    const res = await adminDelete(admin, target.id, key);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      jobId: key,
      status: 'queued',
      statusUrl: `/users/${target.id}/deletion-status`,
    });
    expect((await user(target.id)).status).toBe('deleting');
    expect(await roleCount(target.id)).toBe(0);
    const tombstone = (await job(key)).tombstone_email;

    const again = await adminDelete(admin, target.id, key);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ jobId: key });
    const otherKey = await adminDelete(admin, target.id, newKey());
    expect(otherKey.statusCode).toBe(202);
    expect(otherKey.json()).toMatchObject({ jobId: key });
    expect((await job(key)).tombstone_email).toBe(tombstone);
  });

  it('a key that belongs to another target is 409', async () => {
    const first = await member();
    const second = await member();
    const key = newKey();
    expect((await adminDelete(admin, first.id, key)).statusCode).toBe(202);
    const res = await adminDelete(admin, second.id, key);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect((await user(second.id)).status).toBe('active');
  });

  it('deletes pending and blocked users too', async () => {
    const pending = await createUser(app, { status: 'pending' });
    const blocked = await createUser(app, { status: 'blocked' });
    sensitive.push(pending.id, blocked.id, pending.email, blocked.email);
    for (const target of [pending, blocked]) {
      const res = await adminDelete(admin, target.id, newKey());
      expect(res.statusCode).toBe(202);
      expect((await user(target.id)).status).toBe('deleting');
    }
  });

  it('deleting or deleted without a job is a 503 consistency violation', async () => {
    const target = await createUser(app);
    sensitive.push(target.id, target.email);
    await setStatus(app, target.id, 'deleting');
    const res = await adminDelete(admin, target.id, newKey());
    expect(res.statusCode).toBe(503);
    expect(
      logs
        .lines()
        .some((line) => line.event === 'deletion_consistency_violation'),
    ).toBe(true);
  });

  it('the only active rbac@manage holder cannot be deleted by an admin (409)', async () => {
    const other = await actorWithRoles(app, ['admin']);
    sensitive.push(other.id, other.email);
    // `admin` deletes `other` while `other` is the only manager: but `admin` must stay active to
    // call the route, so give the deleter a role with users@delete_any and no rbac@manage.
    const deleterRole = uniqueName('deleter');
    await db.transaction(async (manager) => {
      const [role] = await manager.query<{ id: string }[]>(
        `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
        [deleterRole],
      );
      const [perm] = await manager.query<{ id: string }[]>(
        `SELECT id FROM permissions WHERE name = 'users'`,
      );
      await manager.query(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, true)`,
        [role.id, perm.id],
      );
      await manager.query(
        `UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1`,
      );
    });
    const deleter = await actorWithRoles(app, [deleterRole]);
    sensitive.push(deleter.id, deleter.email);
    await asOnlyManager(other.id, async () => {
      const key = newKey();
      const res = await adminDelete(deleter, other.id, key);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'last_rbac_manager' });
      expect(await job(key)).toBeUndefined();
      expect((await user(other.id)).status).toBe('active');
    });
  });

  it('role assignment refuses a deleting user (409)', async () => {
    const target = await member();
    await adminDelete(admin, target.id, newKey());
    const put = outsideDeletion(
      await app.inject({
        method: 'PUT',
        url: `/admin/rbac/users/${target.id}/roles`,
        cookies: admin.cookies,
        payload: { roleIds: [await roleId(db, 'user')] },
        remoteAddress: ip(),
      }),
    );
    expect(put.statusCode).toBe(409);
    expect(await roleCount(target.id)).toBe(0);
  });
});

describe('deletion status (spec 1.6 §1.3.4)', () => {
  it('self branch by receipt: 200 with the minimal fields, without a session', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    const res = await statusByReceipt(actor.id, key);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'finishedAt', 'jobId', 'status', 'updatedAt'].sort(),
    );
    expect(body).toMatchObject({
      jobId: key,
      status: 'queued',
      finishedAt: null,
    });
  });

  it('an unknown, malformed or mismatched receipt is the same 404; a cookie is never read', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    const other = await member();
    for (const res of [
      await statusByReceipt(actor.id, randomBytes(16).toString('hex')),
      await statusByReceipt(actor.id, 'not-a-receipt'),
      await statusByReceipt(actor.id, key.toUpperCase()),
      await statusByReceipt(other.id, key),
      // An admin cookie does not turn the self branch into the admin one.
      await statusByReceipt(other.id, key, admin),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('admin branch: 200 for someone else; own id 403; without delete_any 403; unknown 404', async () => {
    const target = await member();
    const key = newKey();
    await adminDelete(admin, target.id, key);
    const res = await statusAsAdmin(admin, target.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobId: key, status: 'queued' });

    expect((await statusAsAdmin(admin, admin.id)).statusCode).toBe(403);
    const plain = await member();
    expect((await statusAsAdmin(plain, target.id)).statusCode).toBe(403);
    expect((await statusAsAdmin(plain, randomUUID())).statusCode).toBe(403);
    expect((await statusAsAdmin(admin, randomUUID())).statusCode).toBe(404);
    const noJob = await member();
    expect((await statusAsAdmin(admin, noJob.id)).statusCode).toBe(404);
    expect(
      (await call('GET', `/users/${target.id}/deletion-status`)).statusCode,
    ).toBe(401);
  });

  it('60 requests per IP per minute', async () => {
    const address = ip();
    const receipt = randomBytes(16).toString('hex');
    for (let n = 0; n < 60; n++) {
      const res = await call('GET', `/users/${randomUUID()}/deletion-status`, {
        headers: { 'deletion-receipt': receipt },
        remoteAddress: address,
      });
      expect(res.statusCode).toBe(404);
    }
    const limited = await call(
      'GET',
      `/users/${randomUUID()}/deletion-status`,
      {
        headers: { 'deletion-receipt': receipt },
        remoteAddress: address,
      },
    );
    expect(limited.statusCode).toBe(429);
  });
});

describe('deletion worker and anonymization (spec 1.6 §1.3.5, §1.3.6)', () => {
  it('erases the photo, anonymizes the row, deletes challenges, and frees the email', async () => {
    const actor = await member();
    const photoKey = `${randomBytes(16).toString('hex')}.webp`;
    sensitive.push(photoKey);
    const storage = app.get(ObjectStorage);
    expect(await storage.write(photoKey, Buffer.from('photo'))).toBe('stored');
    await db.query(
      `UPDATE users SET photo_key = $2, display_name = 'Private Name' WHERE id = $1`,
      [actor.id, photoKey],
    );
    const { key } = await selfDelete(actor);

    const done = await work(key);
    expect(done).toMatchObject({
      status: 'succeeded',
      lease_until: null,
      next_attempt_at: null,
    });
    expect(done.finished_at).not.toBeNull();
    const row = await user(actor.id);
    expect(row).toEqual({
      email: done.tombstone_email,
      display_name: null,
      photo_key: null,
      password_hash: null,
      status: 'deleted',
    });
    expect((await storage.read(photoKey)).kind).toBe('not_found');
    for (const table of [
      'registration_challenges',
      'login_challenges',
      'email_change_challenges',
      'deletion_challenges',
    ]) {
      const rows = await db.query<unknown[]>(
        `SELECT 1 FROM ${table} WHERE user_id = $1`,
        [actor.id],
      );
      expect(rows).toHaveLength(0);
    }
    expect(
      probe.calls.some((c) => c.userId === actor.id && c.jobId === key),
    ).toBe(true);

    const status = await statusByReceipt(actor.id, key);
    expect(status.json()).toMatchObject({ status: 'succeeded' });
    expect(
      status.json<{ finishedAt: string | null }>().finishedAt,
    ).not.toBeNull();

    // The old email is free again: a new registration gets a new id and none of the old roles.
    const reg = outsideDeletion(
      await call('POST', '/auth/register', {
        body: { email: actor.email, password: PASSWORD },
      }),
    );
    expect(reg.statusCode).toBe(201);
    const [fresh] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = $1`,
      [actor.email],
    );
    sensitive.push(fresh.id);
    expect(fresh.id).not.toBe(actor.id);
  });

  it('a retryable failure keeps the user deleting and requeues after a minute; the 5th start fails the job', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    probe.next = { result: 'retryable_failure', code: 'probe_unavailable' };
    await makeDue(key);
    await worker.run();
    const retried = await job(key);
    expect(retried).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error_code: 'probe_unavailable',
      lease_until: null,
    });
    const wait = (retried.next_attempt_at!.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThanOrEqual(61);
    expect((await user(actor.id)).status).toBe('deleting');

    const failed = await work(key);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 5,
      next_attempt_at: null,
      lease_until: null,
    });
    expect((await user(actor.id)).status).toBe('deleting');
    expect((await statusByReceipt(actor.id, key)).json()).toMatchObject({
      status: 'failed',
      finishedAt: null,
    });

    // The admin retries the failed job: same job and tombstone, attempts reset, queued now.
    probe.next = { result: 'succeeded' };
    const tombstone = failed.tombstone_email;
    const retry = await adminDelete(admin, actor.id, newKey());
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ jobId: key, status: 'queued' });
    const requeued = await job(key);
    expect(requeued).toMatchObject({
      status: 'queued',
      attempts: 0,
      last_error_code: null,
      tombstone_email: tombstone,
    });
    expect((await work(key)).status).toBe('succeeded');
    expect((await user(actor.id)).email).toBe(tombstone);
  });

  it('a permanent failure fails the job at once; a thrown eraser is retryable', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    probe.next = 'throw';
    await makeDue(key);
    await worker.run();
    expect(await job(key)).toMatchObject({
      status: 'queued',
      last_error_code: 'eraser_error',
    });
    probe.next = { result: 'permanent_failure', code: 'probe_refused' };
    await makeDue(key);
    await worker.run();
    expect(await job(key)).toMatchObject({
      status: 'failed',
      attempts: 2,
      last_error_code: 'probe_refused',
    });
  });

  it('a running job with an expired lease is claimed again; with 5 starts used it fails instead', async () => {
    const first = await member();
    const second = await member();
    const { key: a } = await selfDelete(first);
    const { key: b } = await selfDelete(second);
    await db.query(
      `UPDATE deletion_jobs SET status = 'running', next_attempt_at = NULL, lease_until = clock_timestamp() - interval '1 second', attempts = $2 WHERE id = $1`,
      [a, 2],
    );
    await db.query(
      `UPDATE deletion_jobs SET status = 'running', next_attempt_at = NULL, lease_until = clock_timestamp() - interval '1 second', attempts = 5 WHERE id = $1`,
      [b],
    );
    await worker.run();
    expect(await job(a)).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(await job(b)).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await user(second.id)).status).toBe('deleting');
  });

  it('a running job with a live lease is left alone, with the 5-minute lease set on claim', async () => {
    const actor = await member();
    const { key } = await selfDelete(actor);
    probe.next = { result: 'retryable_failure', code: 'x_failed' };
    let lease: Date | null = null;
    probe.before = async (jobId) => {
      if (jobId === key) lease = (await job(key)).lease_until;
    };
    await makeDue(key);
    await worker.run();
    probe.before = undefined;
    expect(lease).not.toBeNull();
    const seconds = (lease!.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(config.DELETION_WORKER_LEASE_SECONDS - 30);

    await db.query(
      `UPDATE deletion_jobs SET status = 'running', next_attempt_at = NULL, lease_until = clock_timestamp() + interval '5 minutes' WHERE id = $1`,
      [key],
    );
    await worker.run();
    expect(await job(key)).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('readiness reports the eraser registry', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
      remoteAddress: '127.0.0.1',
    });
    expect(res.json()).toMatchObject({
      checks: { user_data_erasers: 'up' },
    });
  });

  it('logs the deletion events without ids, keys, emails or tombstones (spec 1.6 §1.5)', () => {
    const events = new Set(logs.lines().map((line) => line.event));
    for (const event of [
      'deletion_accepted',
      'deletion_replay',
      'deletion_key_conflict',
      'user_deleting',
      'deletion_job_claimed',
      'deletion_job_retry',
      'deletion_job_failed',
      'deletion_job_succeeded',
      'deletion_admin_retry',
      'user_deleted',
    ]) {
      expect(events).toContain(event);
    }
    const deletionLines = logs
      .lines()
      .filter((line) =>
        (typeof line.event === 'string' ? line.event : '').match(
          /^(deletion|user_delet)/,
        ),
      );
    for (const line of deletionLines) {
      expect(line).not.toHaveProperty('jobId');
      expect(line).not.toHaveProperty('actorUserId');
      expect(line).not.toHaveProperty('targetUserId');
      expect(line).not.toHaveProperty('userId');
    }
  });
});
