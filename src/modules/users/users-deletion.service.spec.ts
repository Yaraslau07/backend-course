import { Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { DataSource, EntityManager } from 'typeorm';

import { IdempotentReplays } from '@/core/authorization/idempotent-replay';
import type { Ownership } from '@/core/authorization/ownership';
import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import {
  type ChallengeEngine,
  ChallengeRejected,
} from '@/modules/challenges/challenge-engine.service';
import type { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

import { UsersDeletionService } from './users-deletion.service';

const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const KEY = '0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210';
const job = (fields: Record<string, unknown> = {}) => ({
  id: KEY,
  user_id: actor,
  status: 'queued',
  created_at: new Date(0),
  updated_at: new Date(1000),
  finished_at: null,
  ...fields,
});
const issued = {
  id: challengeId,
  method: 'otp',
  scenario: 'deletion',
  secret: '123456',
};
const pkViolation = () =>
  Object.assign(new Error('private database detail'), {
    name: 'QueryFailedError',
    driverError: { code: '23505', constraint: 'pk_deletion_jobs' },
  });

function setup() {
  const state = {
    user: { id: actor, email: 'me@example.com', status: 'active' } as
      | Record<string, unknown>
      | undefined,
    byKey: undefined as Record<string, unknown> | undefined,
    forUser: undefined as Record<string, unknown> | undefined,
    holder: true,
    insertError: undefined as Error | undefined,
  };
  const sql = jest.fn((text: string): Promise<unknown> => {
    if (text.startsWith('SELECT id, email, status FROM users'))
      return Promise.resolve(state.user ? [state.user] : []);
    if (text.includes('FROM deletion_jobs WHERE id'))
      return Promise.resolve(state.byKey ? [state.byKey] : []);
    if (text.includes('FROM deletion_jobs WHERE user_id'))
      return Promise.resolve(state.forUser ? [state.forUser] : []);
    if (text.startsWith('INSERT INTO deletion_jobs'))
      return state.insertError
        ? Promise.reject(state.insertError)
        : Promise.resolve([job()]);
    if (text.startsWith('UPDATE deletion_jobs'))
      return Promise.resolve([[job({ status: 'queued' })], 1]);
    if (text.trimStart().startsWith('SELECT EXISTS'))
      return Promise.resolve([{ ok: state.holder }]);
    return Promise.resolve([]);
  });
  const manager = { query: sql } as unknown as EntityManager;
  const transaction = jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
    work(manager),
  );
  const ownership = {
    assertOwner: jest.fn((a: string, b: string) => {
      if (a.toLowerCase() !== b.toLowerCase())
        throw new AppException('ownership_denied');
    }),
  };
  const authorizer = { authorize: jest.fn().mockResolvedValue(undefined) };
  const challenges = {
    issue: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    resend: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    confirm: jest
      .fn()
      .mockResolvedValue({ ok: true, value: { id: challengeId } }),
    claim: jest.fn().mockResolvedValue(true),
    consumeOutstanding: jest.fn().mockResolvedValue(0),
    deliver: jest.fn().mockResolvedValue(undefined),
    accepted: jest.fn().mockReturnValue({ challengeId }),
  };
  const limiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
  const replays = new IdempotentReplays();
  const service = new UsersDeletionService(
    { query: sql, transaction, manager } as unknown as DataSource,
    { get: () => 'otp' } as unknown as ConfigService,
    ownership as unknown as Ownership,
    authorizer as unknown as RbacAuthorizer,
    challenges as unknown as ChallengeEngine,
    limiter as unknown as RateLimiter,
    replays,
  );
  service.onModuleInit();
  return { service, state, sql, challenges, authorizer, limiter, replays };
}
type Setup = ReturnType<typeof setup>;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
}
const confirm = (s: Setup, key = KEY, who: string | null = actor) =>
  s.service.confirm(who ?? undefined, actor, key, {
    challengeId,
    code: '123456',
  });
const ran = (s: Setup, fragment: string) =>
  s.sql.mock.calls.some(([text]) => text.includes(fragment));

describe('UsersDeletionService (spec 1.6)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('replay matcher', () => {
    const request = (key: unknown, userId: unknown) =>
      ({
        headers: { 'idempotency-key': key },
        params: { userId },
      }) as unknown as FastifyRequest;

    it('is registered for the guard and decides replay, conflict or none', async () => {
      const s = setup();
      expect(
        await s.replays.check('deletion_confirm', request(KEY, actor)),
      ).toBe('none');
      s.state.byKey = job();
      expect(
        await s.replays.check(
          'deletion_confirm',
          request(KEY, actor.toUpperCase()),
        ),
      ).toBe('replay');
      expect(
        await s.replays.check('deletion_confirm', request(KEY, other)),
      ).toBe('conflict');
      expect(await s.service.matchReplay(request('bad', actor))).toBe('none');
      expect(await s.service.matchReplay(request(KEY, undefined))).toBe('none');
    });
  });

  describe('challenge', () => {
    it('issues a challenge, spends the email budget and mails the current address', async () => {
      const s = setup();
      expect(await s.service.startChallenge(actor, actor)).toEqual({
        challengeId,
      });
      expect(s.limiter.consume).toHaveBeenCalledWith(
        'deletion_challenge_emails',
        [actor],
        expect.anything(),
      );
      expect(s.challenges.deliver).toHaveBeenCalledWith(
        'me@example.com',
        issued,
      );
    });

    it('refuses someone else, an existing job, an inactive user and a spent budget', async () => {
      const s = setup();
      expect(await codeOf(() => s.service.startChallenge(actor, other))).toBe(
        'ownership_denied',
      );
      s.state.forUser = job();
      expect(await codeOf(() => s.service.startChallenge(actor, actor))).toBe(
        'deletion_exists',
      );
      s.state.forUser = undefined;
      s.state.user = { id: actor, email: 'x', status: 'blocked' };
      expect(await codeOf(() => s.service.startChallenge(actor, actor))).toBe(
        'invalid_session',
      );
      s.state.user = { id: actor, email: 'x', status: 'active' };
      s.limiter.consume.mockResolvedValueOnce({
        allowed: false,
        retryAfterSeconds: 10,
      });
      expect(await codeOf(() => s.service.startChallenge(actor, actor))).toBe(
        'too_many_requests',
      );
      s.challenges.issue.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('resend_cooldown', 'cooldown'),
      });
      expect(await codeOf(() => s.service.startChallenge(actor, actor))).toBe(
        'resend_cooldown',
      );
      expect(s.challenges.deliver).not.toHaveBeenCalled();
    });

    it('resends after locking the challenge, and refuses a body without challengeId', async () => {
      const s = setup();
      expect(
        await s.service.resendChallenge(actor, actor, { challengeId }),
      ).toEqual({ challengeId });
      expect(ran(s, 'FROM deletion_challenges WHERE id = $1 FOR UPDATE')).toBe(
        true,
      );
      expect(
        await codeOf(() => s.service.resendChallenge(actor, actor, {})),
      ).toBe('bad_request');
      s.challenges.resend.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected(
          'challenge_conflict',
          'consumed:job_exists',
        ),
      });
      expect(
        await codeOf(() =>
          s.service.resendChallenge(actor, actor, { challengeId }),
        ),
      ).toBe('challenge_conflict');
      s.state.user = { id: actor, email: 'x', status: 'blocked' };
      expect(
        await codeOf(() =>
          s.service.resendChallenge(actor, actor, { challengeId }),
        ),
      ).toBe('invalid_session');
    });

    it('a user row that vanished is an invalid session', async () => {
      const s = setup();
      s.state.user = undefined;
      expect(await codeOf(() => s.service.startChallenge(actor, actor))).toBe(
        'invalid_session',
      );
    });
  });

  describe('confirm', () => {
    it('accepts in one transaction: job, deleting, roles, version, challenges', async () => {
      const s = setup();
      expect(await confirm(s)).toEqual({
        jobId: KEY,
        status: 'queued',
        statusUrl: `/users/${actor}/deletion-status`,
      });
      for (const fragment of [
        'FROM rbac_policy_state WHERE id = 1 FOR UPDATE',
        'INSERT INTO deletion_jobs',
        "SET status = 'deleting'",
        'DELETE FROM user_roles',
        'version = version + 1',
      ])
        expect(ran(s, fragment)).toBe(true);
      expect(s.challenges.claim).toHaveBeenCalledWith(
        expect.anything(),
        'deletion',
        challengeId,
        'confirmed',
      );
      expect(s.challenges.consumeOutstanding).toHaveBeenCalledTimes(4);
    });

    it('replays an existing key for the same user and refuses one for another user', async () => {
      const s = setup();
      s.state.byKey = job({ status: 'running' });
      expect(await confirm(s, KEY, null)).toMatchObject({
        jobId: KEY,
        status: 'running',
      });
      s.state.byKey = job({ user_id: other });
      expect(await codeOf(() => confirm(s))).toBe('idempotency_conflict');
      expect(s.challenges.confirm).not.toHaveBeenCalled();
    });

    it('fails closed without a verified user when it is not a replay', async () => {
      const s = setup();
      expect(await codeOf(() => confirm(s, KEY, null))).toBe(
        'authorization_unavailable',
      );
    });

    it('validates the key and body before anything else', async () => {
      const s = setup();
      expect(await codeOf(() => confirm(s, 'bad'))).toBe('bad_request');
      expect(
        await codeOf(() => s.service.confirm(actor, actor, KEY, { code: '1' })),
      ).toBe('bad_request');
      expect(s.sql).not.toHaveBeenCalled();
    });

    it('maps refusals: user_inactive → 401, job_exists → the existing job, others as they are', async () => {
      const s = setup();
      s.challenges.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('invalid_challenge', 'user_inactive'),
      });
      expect(await codeOf(() => confirm(s))).toBe('invalid_session');

      s.challenges.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected(
          'challenge_conflict',
          'consumed:job_exists',
        ),
      });
      s.state.forUser = job({ id: OTHER_KEY });
      expect(await confirm(s)).toMatchObject({ jobId: OTHER_KEY });

      s.state.forUser = undefined;
      s.challenges.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected(
          'challenge_conflict',
          'consumed:job_exists',
        ),
      });
      expect(await codeOf(() => confirm(s))).toBe('challenge_conflict');

      s.challenges.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected(
          'attempts_exhausted',
          'consumed:attempts_exhausted',
        ),
      });
      expect(await codeOf(() => confirm(s))).toBe('attempts_exhausted');
    });

    it('returns a job created under another key, consuming the challenge as job_exists', async () => {
      const s = setup();
      s.state.forUser = job({ id: OTHER_KEY });
      expect(await confirm(s)).toMatchObject({ jobId: OTHER_KEY });
      expect(s.challenges.claim).toHaveBeenCalledWith(
        expect.anything(),
        'deletion',
        challengeId,
        'job_exists',
      );
      expect(ran(s, 'INSERT INTO deletion_jobs')).toBe(false);
    });

    it('a challenge claimed concurrently is invalid', async () => {
      const s = setup();
      s.challenges.claim.mockResolvedValueOnce(false);
      expect(await codeOf(() => confirm(s))).toBe('invalid_challenge');
    });

    it('the last rbac@manage holder gets 409; a key raced for another user gets 409', async () => {
      const s = setup();
      s.state.holder = false;
      expect(await codeOf(() => confirm(s))).toBe('last_rbac_manager');
      s.state.holder = true;
      s.state.insertError = pkViolation();
      expect(await codeOf(() => confirm(s))).toBe('idempotency_conflict');
      s.state.insertError = new Error('other');
      expect(await codeOf(() => confirm(s))).toBe('other');
    });
  });

  describe('admin delete', () => {
    it('refuses own id, checks delete_any before lookup, and 404s an unknown target', async () => {
      const s = setup();
      expect(await codeOf(() => s.service.adminDelete(actor, actor, KEY))).toBe(
        'self_confirmation_required',
      );
      s.authorizer.authorize.mockRejectedValueOnce(
        new AppException('permission_denied'),
      );
      expect(await codeOf(() => s.service.adminDelete(actor, other, KEY))).toBe(
        'permission_denied',
      );
      expect(s.sql).not.toHaveBeenCalled();
      s.state.user = undefined;
      expect(await codeOf(() => s.service.adminDelete(actor, other, KEY))).toBe(
        'not_found',
      );
      expect(
        await codeOf(() => s.service.adminDelete(actor, 'not-a-uuid', KEY)),
      ).toBe('not_found');
    });

    it('accepts, replays an existing job, requeues a failed one, and refuses a foreign key', async () => {
      const s = setup();
      s.state.user = { id: other, email: 'x', status: 'blocked' };
      expect(await s.service.adminDelete(actor, other, KEY)).toMatchObject({
        jobId: KEY,
        status: 'queued',
      });
      s.state.forUser = job({ user_id: other, status: 'running' });
      expect(await s.service.adminDelete(actor, other, KEY)).toMatchObject({
        status: 'running',
      });
      s.state.forUser = job({ user_id: other, status: 'failed' });
      expect(await s.service.adminDelete(actor, other, KEY)).toMatchObject({
        status: 'queued',
      });
      expect(ran(s, 'attempts = 0')).toBe(true);
      s.state.byKey = job({ user_id: actor });
      expect(await codeOf(() => s.service.adminDelete(actor, other, KEY))).toBe(
        'idempotency_conflict',
      );
    });

    it('a deleting or deleted target without a job is a 503 consistency violation', async () => {
      const s = setup();
      for (const status of ['deleting', 'deleted']) {
        s.state.user = { id: other, email: 'x', status };
        expect(
          await codeOf(() => s.service.adminDelete(actor, other, KEY)),
        ).toBe('service_unavailable');
      }
    });
  });

  describe('status', () => {
    it('self branch: the receipt must be well formed and name exactly this user', async () => {
      const s = setup();
      expect(
        await codeOf(() => s.service.status(undefined, actor, 'bad')),
      ).toBe('not_found');
      expect(await codeOf(() => s.service.status(undefined, actor, KEY))).toBe(
        'not_found',
      );
      const lettered = 'abcdef12-1111-4111-8111-111111111111';
      s.state.byKey = job({ user_id: lettered });
      expect(
        await codeOf(() =>
          s.service.status(undefined, lettered.toUpperCase(), KEY),
        ),
      ).toBe('not_found');
      s.state.byKey = job();
      expect(await s.service.status(undefined, actor, KEY)).toEqual({
        jobId: KEY,
        status: 'queued',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(1000).toISOString(),
        finishedAt: null,
      });
      s.state.byKey = job({ status: 'succeeded', finished_at: new Date(2000) });
      expect(await s.service.status(undefined, actor, KEY)).toMatchObject({
        finishedAt: new Date(2000).toISOString(),
      });
    });

    it('admin branch: own id 403, delete_any first, then 404 or the job', async () => {
      const s = setup();
      expect(
        await codeOf(() => s.service.status(actor, actor, undefined)),
      ).toBe('forbidden');
      s.authorizer.authorize.mockRejectedValueOnce(
        new AppException('permission_denied'),
      );
      expect(
        await codeOf(() => s.service.status(actor, other, undefined)),
      ).toBe('permission_denied');
      expect(
        await codeOf(() => s.service.status(actor, other, undefined)),
      ).toBe('not_found');
      s.state.forUser = job({ user_id: other });
      expect(await s.service.status(actor, other, undefined)).toMatchObject({
        jobId: KEY,
      });
    });
  });
});
