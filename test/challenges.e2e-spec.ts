import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';

import { AppConfig } from '@/core/config/config.types';
import type { ChallengeScenario } from '@/core/mail/templates';
import {
  ChallengeEngine,
  type ChallengeRef,
  type IssuedChallenge,
  type Outcome,
} from '@/modules/challenges/challenge-engine.service';
import { CHALLENGE_SCENARIOS } from '@/modules/challenges/challenge-scenarios';
import type { ChallengeMethod } from '@/modules/challenges/challenges.types';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { waitForMail } from './utils/mailpit';

/**
 * The email-challenge engine shared by registration, login, email change and deletion
 * ("Email challenges" in docs/invariants.md). Each test drives it the way a flow will:
 * lock the user, call the engine, commit, and only then act on the outcome.
 */
describe('Email challenge engine (e2e)', () => {
  const logs = new LogCapture();
  const secrets: string[] = [];
  let app: NestFastifyApplication;
  let config: AppConfig;
  let engine: ChallengeEngine;
  let db: DataSource;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({ logs }));
    engine = app.get(ChallengeEngine);
    db = app.get(DataSource);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, secrets);
    await app.close();
  });

  /* ---------- helpers: what a flow does around the engine ---------- */

  async function createUser(
    status = 'active',
  ): Promise<{ id: string; email: string }> {
    const email = `challenge-${randomUUID()}@example.com`;
    const [user] = await db.query<{ id: string }[]>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, 'hash', $2) RETURNING id`,
      [email, status],
    );
    return { id: user.id, email };
  }

  /** Every flow takes the user lock first (lock order: user → challenge). */
  async function withUserLock<T>(
    userId: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);
      return work(manager);
    });
  }

  async function issue(
    scenario: ChallengeScenario,
    userId: string,
    method: ChallengeMethod = 'otp',
  ): Promise<Outcome<IssuedChallenge>> {
    const outcome = await withUserLock(userId, (m) =>
      engine.issue(m, scenario, {
        userId,
        method,
        newEmail:
          scenario === 'email_change'
            ? `new-${randomUUID()}@example.com`
            : undefined,
      }),
    );
    if (outcome.ok) secrets.push(outcome.value.secret);
    return outcome;
  }

  async function issued(
    scenario: ChallengeScenario,
    userId: string,
    method: ChallengeMethod = 'otp',
  ): Promise<IssuedChallenge> {
    const outcome = await issue(scenario, userId, method);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Confirm as a flow would: resolve the user, lock it, confirm, claim on success, commit. */
  async function confirm(
    scenario: ChallengeScenario,
    ref: ChallengeRef & ({ code: string } | { token: string }),
    userEligible = true,
  ) {
    const userId = await engine.findUserId(db.manager, scenario, ref);
    if (!userId)
      return {
        ok: false as const,
        code: 'invalid_challenge',
        reason: 'not_found',
      };
    return withUserLock(userId, async (m) => {
      const outcome = await engine.confirm(m, scenario, {
        ...ref,
        userId,
        userEligible,
      });
      if (!outcome.ok) {
        return {
          ok: false as const,
          code: outcome.error.code,
          reason: outcome.error.reason,
        };
      }
      const claimed = await engine.claim(
        m,
        scenario,
        outcome.value.id,
        'confirmed',
      );
      return { ok: true as const, claimed, challenge: outcome.value };
    });
  }

  async function resend(
    scenario: ChallengeScenario,
    challengeId: string,
    userId: string,
    userEligible = true,
  ) {
    const outcome = await withUserLock(userId, (m) =>
      engine.resend(m, scenario, { challengeId, userId, userEligible }),
    );
    if (outcome.ok) secrets.push(outcome.value.secret);
    return outcome;
  }

  const table = (scenario: ChallengeScenario) =>
    CHALLENGE_SCENARIOS[scenario].table;

  async function row(scenario: ChallengeScenario, id: string) {
    const [found] = await db.query<
      {
        attempts: number;
        consumed_reason: string | null;
        secret_hash: Buffer;
        method: string;
      }[]
    >(
      `SELECT attempts, consumed_reason, secret_hash, method FROM ${table(scenario)} WHERE id = $1`,
      [id],
    );
    return found;
  }

  /** Moves a challenge's last send into the past. */
  async function age(scenario: ChallengeScenario, id: string, seconds: number) {
    await db.query(
      `UPDATE ${table(scenario)} SET last_sent_at = last_sent_at - make_interval(secs => $2) WHERE id = $1`,
      [id, seconds],
    );
  }

  const wrongCode = (code: string) =>
    String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  /* ---------- issue ---------- */

  describe.each(['registration', 'login', 'email_change', 'deletion'] as const)(
    '%s',
    (scenario) => {
      it('issues an OTP stored only as an HMAC, and confirms it once', async () => {
        const user = await createUser(
          scenario === 'registration' ? 'pending' : 'active',
        );
        const challenge = await issued(scenario, user.id);

        expect(challenge.secret).toMatch(/^\d{6}$/);
        const stored = await row(scenario, challenge.id);
        expect(stored.secret_hash).toHaveLength(32);
        expect(JSON.stringify(stored)).not.toContain(challenge.secret);

        const first = await confirm(scenario, {
          challengeId: challenge.id,
          code: challenge.secret,
        });
        expect(first).toMatchObject({ ok: true, claimed: true });
        expect(await row(scenario, challenge.id)).toMatchObject({
          consumed_reason: 'confirmed',
        });

        expect(
          await confirm(scenario, {
            challengeId: challenge.id,
            code: challenge.secret,
          }),
        ).toMatchObject({ ok: false, code: 'invalid_challenge' });
      });

      it('issues a magic link and confirms it by token', async () => {
        const user = await createUser(
          scenario === 'registration' ? 'pending' : 'active',
        );
        const challenge = await issued(scenario, user.id, 'magic_link');

        if (scenario === 'registration') {
          expect(challenge.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        } else {
          expect(challenge.secret).toMatch(
            new RegExp(`^${challenge.id}\\.[A-Za-z0-9_-]{43}$`),
          );
        }

        expect(
          await confirm(scenario, { token: challenge.secret }),
        ).toMatchObject({
          ok: true,
          claimed: true,
        });
      });
    },
  );

  it('refuses an email change without a target address, and a target address anywhere else', async () => {
    const user = await createUser();

    await expect(
      withUserLock(user.id, (m) =>
        engine.issue(m, 'email_change', { userId: user.id, method: 'otp' }),
      ),
    ).rejects.toThrow('newEmail is required');
    await expect(
      withUserLock(user.id, (m) =>
        engine.issue(m, 'login', {
          userId: user.id,
          method: 'otp',
          newEmail: 'x@example.com',
        }),
      ),
    ).rejects.toThrow('newEmail is required');
  });

  it('keeps the method the challenge was created with', async () => {
    const user = await createUser();
    const challenge = await issued('login', user.id, 'magic_link');

    expect(await row('login', challenge.id)).toMatchObject({
      method: 'magic_link',
    });
    expect(
      await confirm('login', { challengeId: challenge.id, code: '123456' }),
    ).toMatchObject({
      ok: false,
      code: 'invalid_challenge',
      reason: 'method_mismatch',
    });
  });

  /* ---------- OTP attempts ---------- */

  describe('OTP attempts', () => {
    it('counts a wrong code, and the count survives the error', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);

      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: wrongCode(challenge.secret),
        }),
      ).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
        reason: 'wrong_secret',
      });
      expect(await row('login', challenge.id)).toMatchObject({
        attempts: 1,
        consumed_reason: null,
      });
    });

    it('still checks the 5th attempt, which can succeed', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      for (let i = 0; i < 4; i++) {
        await confirm('login', {
          challengeId: challenge.id,
          code: wrongCode(challenge.secret),
        });
      }

      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: true, claimed: true });
    });

    it('answers a wrong 5th with 400 and exhausts the challenge; the next request is 429 even with the right code', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      const wrong = {
        challengeId: challenge.id,
        code: wrongCode(challenge.secret),
      };
      for (let i = 0; i < 4; i++) await confirm('login', wrong);

      expect(await confirm('login', wrong)).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
        reason: 'wrong_secret',
      });
      expect(await row('login', challenge.id)).toMatchObject({
        attempts: 5,
        consumed_reason: 'attempts_exhausted',
      });
      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: false, code: 'attempts_exhausted' });
    });

    it('does not count a wrong magic-link token', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id, 'magic_link');
      const forged = `${challenge.id}.${'A'.repeat(43)}`;

      for (let i = 0; i < 6; i++) {
        expect(await confirm('login', { token: forged })).toMatchObject({
          ok: false,
          code: 'invalid_challenge',
          reason: 'wrong_secret',
        });
      }
      expect(await row('login', challenge.id)).toMatchObject({ attempts: 0 });
      expect(await confirm('login', { token: challenge.secret })).toMatchObject(
        { ok: true },
      );
    });
  });

  /* ---------- TTL ---------- */

  describe('expiry (10 minutes from the last send)', () => {
    it('rejects an expired challenge without counting the attempt, even with the right code', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      await age('login', challenge.id, 601);

      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
        reason: 'expired',
      });
      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: wrongCode(challenge.secret),
        }),
      ).toMatchObject({ reason: 'expired' });
      expect(await row('login', challenge.id)).toMatchObject({ attempts: 0 });
    });

    it('treats exactly 10 minutes as expired', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      await age('login', challenge.id, 600);

      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: false, reason: 'expired' });
    });

    it('accepts a challenge just inside the window', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      await age('login', challenge.id, 590);

      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: true });
    });
  });

  /* ---------- ownership, eligibility, unknown ids ---------- */

  describe('lookup', () => {
    it('rejects an unknown id or token as not found', async () => {
      expect(
        await confirm('login', { challengeId: randomUUID(), code: '123456' }),
      ).toMatchObject({ ok: false, code: 'invalid_challenge' });
      expect(
        await confirm('registration', { token: 'A'.repeat(43) }),
      ).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
      });
    });

    it('rejects a malformed id or token without touching the database', async () => {
      expect(
        await engine.findUserId(db.manager, 'login', { challengeId: 'nope' }),
      ).toBeNull();
      expect(
        await engine.findUserId(db.manager, 'login', { token: 'nope' }),
      ).toBeNull();
    });

    it("does not let one user confirm another user's challenge", async () => {
      const owner = await createUser();
      const other = await createUser();
      const challenge = await issued('login', owner.id);

      const outcome = await withUserLock(other.id, (m) =>
        engine.confirm(m, 'login', {
          challengeId: challenge.id,
          code: challenge.secret,
          userId: other.id,
          userEligible: true,
        }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        error: { reason: 'not_found' },
      });
      expect(await row('login', challenge.id)).toMatchObject({
        consumed_reason: null,
      });
    });

    it('consumes the challenge as user_inactive when the user may no longer confirm', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);

      expect(
        await confirm(
          'login',
          { challengeId: challenge.id, code: challenge.secret },
          false,
        ),
      ).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
        reason: 'user_inactive',
      });
      expect(await row('login', challenge.id)).toMatchObject({
        consumed_reason: 'user_inactive',
      });
      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: false, code: 'invalid_challenge' });
    });
  });

  /* ---------- issuing again and resend ---------- */

  describe('a new challenge and resend', () => {
    it('refuses a new challenge within 60 s of the last send, with the seconds left', async () => {
      const user = await createUser();
      await issued('login', user.id);

      const again = await issue('login', user.id);

      expect(again).toMatchObject({
        ok: false,
        error: {
          code: 'resend_cooldown',
          extras: { retryAfterSeconds: expect.any(Number) as number },
        },
      });
      if (!again.ok) {
        expect(again.error.extras.retryAfterSeconds).toBeGreaterThanOrEqual(59);
        expect(again.error.extras.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it('after 60 s, a new challenge replaces the old one, whose code stops working', async () => {
      const user = await createUser();
      const old = await issued('login', user.id);
      await age('login', old.id, 61);

      const fresh = await issued('login', user.id);

      expect(await row('login', old.id)).toMatchObject({
        consumed_reason: 'replaced',
      });
      expect(
        await confirm('login', { challengeId: old.id, code: old.secret }),
      ).toMatchObject({
        ok: false,
        code: 'invalid_challenge',
      });
      expect(
        await confirm('login', { challengeId: fresh.id, code: fresh.secret }),
      ).toMatchObject({
        ok: true,
      });
    });

    it('refuses a resend within 60 s', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);

      expect(await resend('login', challenge.id, user.id)).toMatchObject({
        ok: false,
        error: { code: 'resend_cooldown' },
      });
    });

    it('a resend replaces the secret, resets attempts and restarts the TTL; the old code stops working', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      await confirm('login', {
        challengeId: challenge.id,
        code: wrongCode(challenge.secret),
      });
      await confirm('login', {
        challengeId: challenge.id,
        code: wrongCode(challenge.secret),
      });
      await age('login', challenge.id, 590);

      const resent = await resend('login', challenge.id, user.id);
      if (!resent.ok) throw resent.error;

      expect(resent.value.id).toBe(challenge.id);
      expect(await row('login', challenge.id)).toMatchObject({
        attempts: 0,
        consumed_reason: null,
      });
      await age('login', challenge.id, 30); // 620 s after the first send, 30 s after the resend
      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: challenge.secret,
        }),
      ).toMatchObject({ ok: false, code: 'invalid_challenge' });
      expect(
        await confirm('login', {
          challengeId: challenge.id,
          code: resent.value.secret,
        }),
      ).toMatchObject({ ok: true });
    });

    it('resends an expired challenge (expiry stops confirmation, not resend)', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id, 'magic_link');
      await age('login', challenge.id, 700);

      const resent = await resend('login', challenge.id, user.id);
      if (!resent.ok) throw resent.error;

      expect(resent.value.method).toBe('magic_link');
      expect(
        await confirm('login', { token: resent.value.secret }),
      ).toMatchObject({ ok: true });
      expect(await confirm('login', { token: challenge.secret })).toMatchObject(
        { ok: false },
      );
    });

    it.each([
      ['login', 'confirmed', 'invalid_challenge'],
      ['login', 'replaced', 'invalid_challenge'],
      ['login', 'user_inactive', 'invalid_challenge'],
      ['login', 'attempts_exhausted', 'attempts_exhausted'],
      ['email_change', 'admin_override', 'challenge_conflict'],
      ['email_change', 'email_conflict', 'challenge_conflict'],
      ['deletion', 'job_exists', 'challenge_conflict'],
    ] as const)(
      '%s: answers resend of a challenge consumed as %s with %s',
      async (scenario, reason, code) => {
        const user = await createUser();
        const challenge = await issued(scenario, user.id);
        await withUserLock(user.id, (m) =>
          engine.claim(m, scenario, challenge.id, reason),
        );
        await age(scenario, challenge.id, 61);

        expect(await resend(scenario, challenge.id, user.id)).toMatchObject({
          ok: false,
          error: { code, reason: `consumed:${reason}` },
        });
      },
    );

    it("does not resend someone else's challenge", async () => {
      const owner = await createUser();
      const other = await createUser();
      const challenge = await issued('login', owner.id);
      await age('login', challenge.id, 61);

      expect(await resend('login', challenge.id, other.id)).toMatchObject({
        ok: false,
        error: { code: 'invalid_challenge', reason: 'not_found' },
      });
    });
  });

  /* ---------- claim and bulk consumption ---------- */

  describe('claim-then-act', () => {
    it('claims a challenge once; a second claim reports false', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);

      await withUserLock(user.id, async (m) => {
        expect(await engine.claim(m, 'login', challenge.id, 'confirmed')).toBe(
          true,
        );
        expect(await engine.claim(m, 'login', challenge.id, 'confirmed')).toBe(
          false,
        );
      });
    });

    it("consumes a user's outstanding challenge with a given reason", async () => {
      const user = await createUser();
      const challenge = await issued('email_change', user.id);

      const consumed = await withUserLock(user.id, (m) =>
        engine.consumeOutstanding(m, 'email_change', user.id, 'admin_override'),
      );

      expect(consumed).toBe(1);
      expect(await row('email_change', challenge.id)).toMatchObject({
        consumed_reason: 'admin_override',
      });
    });
  });

  /* ---------- concurrency ---------- */

  describe('concurrency', () => {
    it('two confirms with the right code at the same time: exactly one wins', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);
      const ref = { challengeId: challenge.id, code: challenge.secret };

      const results = await Promise.all([
        confirm('login', ref),
        confirm('login', ref),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        expect.objectContaining({ code: 'invalid_challenge' }),
      ]);
    });

    it('two new challenges for one user at the same time: one is issued, the other cools down', async () => {
      const user = await createUser();

      const results = await Promise.all([
        issue('login', user.id),
        issue('login', user.id),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const [{ count }] = await db.query<{ count: string }[]>(
        `SELECT count(*) FROM login_challenges WHERE user_id = $1`,
        [user.id],
      );
      expect(count).toBe('1');
    });

    it('without the user lock, the partial unique index still refuses a second outstanding challenge', async () => {
      const user = await createUser();
      const unlocked = () =>
        db.transaction((m) =>
          engine.issue(m, 'login', { userId: user.id, method: 'otp' }),
        );

      const results = await Promise.allSettled([unlocked(), unlocked()]);

      // Exactly one wins. The loser either overlapped (the partial unique index refuses it) or ran
      // after the winner committed (it sees the new challenge and cools down): which one depends on
      // timing, never on correctness. Either way there is only one outstanding challenge.
      const issued = results.filter(
        (r) => r.status === 'fulfilled' && r.value.ok,
      );
      const lost = results.filter((r) => !issued.includes(r));
      expect(issued).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const [loser] = lost;
      if (loser.status === 'rejected') {
        expect(loser.reason).toBeInstanceOf(QueryFailedError);
      } else {
        expect(loser.value).toMatchObject({
          ok: false,
          error: expect.objectContaining({ code: 'resend_cooldown' }) as object,
        });
      }
      const [{ count }] = await db.query<{ count: string }[]>(
        `SELECT count(*) FROM login_challenges WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id],
      );
      expect(count).toBe('1');
    });
  });

  /* ---------- delivery ---------- */

  describe('delivery (after commit)', () => {
    it('mails the code; the code from the mail confirms', async () => {
      const user = await createUser();
      const challenge = await issued('login', user.id);

      await engine.deliver(user.email, challenge);

      const mail = await waitForMail(user.email);
      const code = /\b(\d{6})\b/.exec(mail.text)?.[1] ?? '';
      expect(
        await confirm('login', { challengeId: challenge.id, code }),
      ).toMatchObject({ ok: true });
    });

    it('mails a magic link; the token from its fragment confirms', async () => {
      const user = await createUser('pending');
      const challenge = await issued('registration', user.id, 'magic_link');

      await engine.deliver(user.email, challenge);

      const mail = await waitForMail(user.email);
      const link = new URL(/https?:\/\/\S+/.exec(mail.text)?.[0] ?? '');
      const token = new URLSearchParams(link.hash.slice(1)).get('token') ?? '';
      expect(await confirm('registration', { token })).toMatchObject({
        ok: true,
      });
    });
  });

  it('logs challenge events without secrets, emails or (for deletion) ids', () => {
    const events = logs
      .lines()
      .filter((line) => line.msg === 'challenge event');

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).toEqual(
        expect.objectContaining({
          scenario: expect.any(String) as string,
          event: expect.any(String) as string,
        }),
      );
      if (event.scenario === 'deletion')
        expect(event.challengeId).toBeUndefined();
    }
    expect(events.some((e) => e.event === 'issued')).toBe(true);
    expect(events.some((e) => e.event === 'exhausted')).toBe(true);
    expect(events.some((e) => e.event === 'confirm_rejected')).toBe(true);
  });
});

describe('Email challenge engine when SMTP is down (e2e)', () => {
  it('keeps the committed challenge and answers 503 with the safe fields, so a resend can deliver it later', async () => {
    const { app } = await createTestApp({ env: { SMTP_PORT: '1' } });
    try {
      const engine = app.get(ChallengeEngine);
      const db = app.get(DataSource);
      const [user] = await db.query<{ id: string }[]>(
        `INSERT INTO users (email, password_hash, status) VALUES ($1, 'hash', 'active') RETURNING id`,
        [`down-${randomUUID()}@example.com`],
      );
      const outcome = await db.transaction((m) =>
        engine.issue(m, 'login', { userId: user.id, method: 'otp' }),
      );
      if (!outcome.ok) throw outcome.error;

      await expect(
        engine.deliver('down@example.com', outcome.value),
      ).rejects.toMatchObject({
        code: 'service_unavailable',
        extras: {
          confirmationRequired: true,
          method: 'otp',
          attemptId: outcome.value.id,
          retryAfterSeconds: 60,
        },
      });

      const [stored] = await db.query<{ consumed_at: Date | null }[]>(
        `SELECT consumed_at FROM login_challenges WHERE id = $1`,
        [outcome.value.id],
      );
      expect(stored.consumed_at).toBeNull();
    } finally {
      await app.close();
    }
  });
});
