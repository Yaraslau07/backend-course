import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import type { MailService } from '@/core/mail/mail.service';

import { ChallengeEngine } from './challenge-engine.service';
import { generateMagicSecret, hashSecret } from './challenge-secrets';

/**
 * The engine's decisions with a scripted database. The SQL itself (locks, conditional updates,
 * the partial unique index, concurrency) is covered against Postgres in test/challenges.e2e-spec.ts.
 */
const KEY = Buffer.alloc(32, 4).toString('base64url');
const ID = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const USER = 'user-1';
const config = { get: () => KEY } as unknown as ConfigService;
const engine = new ChallengeEngine(config, {} as MailService);

interface FakeRow {
  id?: string;
  user_id?: string;
  method?: 'otp' | 'magic_link';
  secret: string;
  attempts?: number;
  consumed_reason?: string | null;
  age?: number;
  new_email?: string | null;
}

/** A manager whose SELECT … FOR UPDATE returns `row` (if any); records every statement. */
function managerWith(
  row?: FakeRow,
  scenario: 'login' | 'registration' = 'login',
) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve(
        row
          ? [
              {
                id: row.id ?? ID,
                user_id: row.user_id ?? USER,
                method: row.method ?? 'otp',
                secret_hash: hashSecret(KEY, scenario, row.secret),
                attempts: row.attempts ?? 0,
                consumed_reason: row.consumed_reason ?? null,
                new_email: row.new_email ?? null,
                age: row.age ?? 0,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith('SELECT user_id')) {
      return Promise.resolve(row ? [{ user_id: row.user_id ?? USER }] : []);
    }
    if (sql.trimStart().startsWith('INSERT'))
      return Promise.resolve([{ id: ID }]);
    if (sql.includes('RETURNING consumed_reason')) {
      const exhausted = (row?.attempts ?? 0) + 1 >= 5;
      return Promise.resolve([
        [{ consumed_reason: exhausted ? 'attempts_exhausted' : null }],
        1,
      ]);
    }
    return Promise.resolve([[], 1]);
  });
  return { manager: { query } as unknown as EntityManager, statements };
}

const updates = (statements: { sql: string; params: unknown[] }[]) =>
  statements.filter((s) => s.sql.trimStart().startsWith('UPDATE'));

describe('ChallengeEngine decisions', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  describe('confirm()', () => {
    const otp = (code = '123456') => ({
      challengeId: ID,
      code,
      userId: USER,
      userEligible: true,
    });

    it('accepts the right code and consumes nothing', async () => {
      const { manager, statements } = managerWith({
        secret: '123456',
        attempts: 4,
      });

      const outcome = await engine.confirm(manager, 'login', otp());

      expect(outcome).toEqual({
        ok: true,
        value: {
          id: ID,
          userId: USER,
          method: 'otp',
          attempts: 4,
          newEmail: null,
        },
      });
      expect(updates(statements)).toHaveLength(0);
    });

    it('counts a wrong code with a conditional exhaustion in the same statement', async () => {
      const { manager, statements } = managerWith({ secret: '123456' });

      const outcome = await engine.confirm(manager, 'login', otp('654321'));

      expect(outcome).toMatchObject({
        ok: false,
        error: { reason: 'wrong_secret' },
      });
      expect(updates(statements)).toHaveLength(1);
      expect(updates(statements)[0].sql).toContain("'attempts_exhausted'");
      expect(updates(statements)[0].params).toEqual([ID, 5]);
    });

    it.each([
      ['a code that is not six digits', otp('12345'), 'malformed'],
      ['an id that is not a UUID', { ...otp(), challengeId: 'x' }, 'malformed'],
      [
        'a token in the wrong format',
        { token: 'x', userId: USER, userEligible: true },
        'malformed',
      ],
    ])(
      'rejects %s before touching the database',
      async (_name, input, reason) => {
        const { manager, statements } = managerWith({ secret: '123456' });

        expect(await engine.confirm(manager, 'login', input)).toMatchObject({
          ok: false,
          error: { code: 'invalid_challenge', reason },
        });
        expect(statements).toHaveLength(0);
      },
    );

    it.each([
      ['missing', undefined, 'invalid_challenge', 'not_found'],
      [
        "someone else's",
        { secret: '123456', user_id: 'other' },
        'invalid_challenge',
        'not_found',
      ],
      [
        'exhausted',
        { secret: '123456', consumed_reason: 'attempts_exhausted' },
        'attempts_exhausted',
        'consumed:attempts_exhausted',
      ],
      [
        'overridden by an admin',
        { secret: '123456', consumed_reason: 'admin_override' },
        'challenge_conflict',
        'consumed:admin_override',
      ],
      [
        'replaced',
        { secret: '123456', consumed_reason: 'replaced' },
        'invalid_challenge',
        'consumed:replaced',
      ],
      [
        'of the other method',
        { secret: '123456', method: 'magic_link' as const },
        'invalid_challenge',
        'method_mismatch',
      ],
      [
        'expired',
        { secret: '123456', age: 601 },
        'invalid_challenge',
        'expired',
      ],
    ])('rejects a %s challenge', async (_name, row, code, reason) => {
      const { manager } = managerWith(row);

      expect(await engine.confirm(manager, 'login', otp())).toMatchObject({
        ok: false,
        error: { code, reason },
      });
    });

    it('consumes the challenge as user_inactive for a user who may no longer confirm', async () => {
      const { manager, statements } = managerWith({ secret: '123456' });

      const outcome = await engine.confirm(manager, 'login', {
        ...otp(),
        userEligible: false,
      });

      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'invalid_challenge', reason: 'user_inactive' },
      });
      expect(updates(statements)[0].params).toEqual([ID, 'user_inactive']);
    });

    it('logs the 5th wrong code as an exhaustion, and still answers 400', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const { manager } = managerWith({ secret: '123456', attempts: 4 });

      const outcome = await engine.confirm(manager, 'login', otp('654321'));

      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'invalid_challenge', reason: 'wrong_secret' },
      });
      expect(
        log.mock.calls.map((call) => (call[0] as { event: string }).event),
      ).toEqual(['exhausted', 'confirm_rejected']);
    });

    it('does not count a wrong magic-link token', async () => {
      const secret = generateMagicSecret();
      const { manager, statements } = managerWith({
        secret,
        method: 'magic_link',
      });

      const outcome = await engine.confirm(manager, 'login', {
        token: `${ID}.${generateMagicSecret()}`,
        userId: USER,
        userEligible: true,
      });

      expect(outcome).toMatchObject({
        ok: false,
        error: { reason: 'wrong_secret' },
      });
      expect(updates(statements)).toHaveLength(0);
    });

    it('finds a registration magic link by the HMAC of its token', async () => {
      const secret = generateMagicSecret();
      const { manager, statements } = managerWith(
        { secret, method: 'magic_link' },
        'registration',
      );

      const outcome = await engine.confirm(manager, 'registration', {
        token: secret,
        userId: USER,
        userEligible: true,
      });

      expect(outcome.ok).toBe(true);
      expect(statements[0].sql).toContain('secret_hash = $1');
      expect(statements[0].params).toEqual([
        hashSecret(KEY, 'registration', secret),
      ]);
    });
  });

  describe('issue()', () => {
    it('creates the first challenge without replacing anything', async () => {
      const { manager, statements } = managerWith(undefined);

      const outcome = await engine.issue(manager, 'login', {
        userId: USER,
        method: 'otp',
      });

      expect(outcome).toMatchObject({
        ok: true,
        value: { id: ID, method: 'otp' },
      });
      expect(updates(statements)).toHaveLength(0);
    });

    it('refuses within the cooldown, with the seconds left', async () => {
      const { manager } = managerWith({ secret: '1', age: 15.2 });

      expect(
        await engine.issue(manager, 'login', { userId: USER, method: 'otp' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'resend_cooldown', extras: { retryAfterSeconds: 45 } },
      });
    });

    it('replaces an older challenge after the cooldown', async () => {
      const { manager, statements } = managerWith({ secret: '1', age: 61 });

      await engine.issue(manager, 'login', {
        userId: USER,
        method: 'magic_link',
      });

      expect(updates(statements)[0].params).toEqual([ID, 'replaced']);
    });

    it('refuses a target address outside email change, and its absence inside it', async () => {
      const { manager } = managerWith(undefined);

      await expect(
        engine.issue(manager, 'email_change', { userId: USER, method: 'otp' }),
      ).rejects.toThrow('newEmail is required');
      await expect(
        engine.issue(manager, 'login', {
          userId: USER,
          method: 'otp',
          newEmail: 'x@example.com',
        }),
      ).rejects.toThrow('newEmail is required');
    });

    it('stores the target address for an email change', async () => {
      const { manager, statements } = managerWith(undefined);

      await engine.issue(manager, 'email_change', {
        userId: USER,
        method: 'otp',
        newEmail: 'new@example.com',
      });

      const insert = statements.find((s) =>
        s.sql.trimStart().startsWith('INSERT'),
      );
      expect(insert?.sql).toContain('new_email');
      expect(insert?.params[3]).toBe('new@example.com');
    });

    it('returns the full magic-link token, which includes the id', async () => {
      const { manager } = managerWith(undefined);

      const outcome = await engine.issue(manager, 'login', {
        userId: USER,
        method: 'magic_link',
      });

      expect(outcome.ok && outcome.value.secret).toMatch(
        new RegExp(`^${ID}\\.`),
      );
    });
  });

  describe('issue() with cooldownFromLatest', () => {
    it('refuses while the latest challenge, even a consumed one, is within the cooldown', async () => {
      const { manager } = managerWith(undefined);
      jest.spyOn(engine, 'latest').mockResolvedValue({
        id: ID,
        method: 'otp',
        outstanding: false,
        age: 20,
      });

      expect(
        await engine.issue(manager, 'registration', {
          userId: USER,
          method: 'otp',
          cooldownFromLatest: true,
        }),
      ).toMatchObject({ ok: false, error: { code: 'resend_cooldown' } });
    });

    it('issues once the latest challenge is older than the cooldown', async () => {
      const { manager } = managerWith(undefined);
      jest.spyOn(engine, 'latest').mockResolvedValue({
        id: ID,
        method: 'otp',
        outstanding: false,
        age: 61,
      });

      expect(
        await engine.issue(manager, 'registration', {
          userId: USER,
          method: 'otp',
          cooldownFromLatest: true,
        }),
      ).toMatchObject({ ok: true });
    });
  });

  describe('latest()', () => {
    it('returns the newest challenge or null', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([
          { id: ID, method: 'otp', outstanding: true, age: 3 },
        ])
        .mockResolvedValueOnce([]);
      const manager = { query } as unknown as EntityManager;

      expect(await engine.latest(manager, 'registration', USER)).toMatchObject({
        id: ID,
      });
      expect(await engine.latest(manager, 'registration', USER)).toBeNull();
    });
  });

  describe('resend()', () => {
    const input = { challengeId: ID, userId: USER, userEligible: true };

    it('replaces the secret after the cooldown, keeping the method', async () => {
      const { manager, statements } = managerWith({ secret: '1', age: 61 });

      const outcome = await engine.resend(manager, 'login', input);

      expect(outcome).toMatchObject({
        ok: true,
        value: { id: ID, method: 'otp' },
      });
      expect(updates(statements)[0].sql).toContain('attempts = 0');
    });

    it.each([
      [
        'an id that is not a UUID',
        { ...input, challengeId: 'x' },
        undefined,
        'not_found',
      ],
      ['a missing challenge', input, undefined, 'not_found'],
      ['a cooldown', input, { secret: '1', age: 10 }, 'cooldown'],
      [
        'a consumed challenge',
        input,
        { secret: '1', age: 61, consumed_reason: 'job_exists' },
        'consumed:job_exists',
      ],
    ])('refuses %s', async (_name, request, row, reason) => {
      const { manager } = managerWith(row);

      expect(await engine.resend(manager, 'login', request)).toMatchObject({
        ok: false,
        error: { reason },
      });
    });

    it('consumes the challenge of a user who may no longer use it', async () => {
      const { manager, statements } = managerWith({ secret: '1', age: 61 });

      expect(
        await engine.resend(manager, 'login', {
          ...input,
          userEligible: false,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'invalid_challenge', reason: 'user_inactive' },
      });
      expect(updates(statements)[0].params).toEqual([ID, 'user_inactive']);
    });
  });

  describe('findUserId()', () => {
    it('reads the owner by id, or null for a malformed reference', async () => {
      const { manager } = managerWith({ secret: '1' });

      expect(
        await engine.findUserId(manager, 'login', { challengeId: ID }),
      ).toBe(USER);
      expect(
        await engine.findUserId(manager, 'login', { challengeId: 'x' }),
      ).toBeNull();
    });

    it('returns null when nothing matches', async () => {
      const { manager } = managerWith(undefined);

      expect(
        await engine.findUserId(manager, 'login', { challengeId: ID }),
      ).toBeNull();
    });
  });

  describe('claim() and consumeOutstanding()', () => {
    it('report how many rows they consumed', async () => {
      const { manager } = managerWith(undefined);

      expect(await engine.claim(manager, 'login', ID, 'confirmed')).toBe(true);
      expect(
        await engine.consumeOutstanding(
          manager,
          'login',
          USER,
          'user_inactive',
        ),
      ).toBe(1);
    });
  });

  it('never logs the id of a deletion challenge', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { manager } = managerWith(undefined);

    await engine.issue(manager, 'deletion', { userId: USER, method: 'otp' });
    await engine.issue(managerWith(undefined).manager, 'login', {
      userId: USER,
      method: 'otp',
    });

    expect(log.mock.calls[0][0]).toEqual({
      scenario: 'deletion',
      event: 'issued',
      method: 'otp',
    });
    expect(log.mock.calls[1][0]).toMatchObject({
      scenario: 'login',
      challengeId: ID,
    });
  });
});
