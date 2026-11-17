import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import {
  type ChallengeEngine,
  ChallengeRejected,
} from '@/modules/challenges/challenge-engine.service';

import { LoginService } from './login.service';
import type { PasswordHasher } from './password-hasher';
import type { TokenService } from './tokens/token.service';

/**
 * Login's decisions with the database, engine and limiter scripted. The real flow, against
 * Postgres and Mailpit, is in test/login.e2e-spec.ts.
 */
const USER = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const ATTEMPT = '9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d';
const EMAIL = 'a@example.com';
const PAIR = { access: 'a.b.c', refresh: 'd.e.f' };
const KEY = Buffer.alloc(32, 1).toString('base64url');
const issued = {
  scenario: 'login' as const,
  id: ATTEMPT,
  method: 'otp' as const,
  secret: '123456',
};

type Row = {
  id: string;
  email: string;
  status: string;
  password_hash?: string | null;
};

function setup(
  options: {
    confirm?: boolean;
    user?: Row | null;
    lockedStatus?: string | null;
    passwordOk?: boolean;
    allowed?: boolean;
    owner?: string | null;
  } = {},
) {
  const user =
    options.user === null
      ? null
      : (options.user ?? {
          id: USER,
          email: EMAIL,
          status: 'active',
          password_hash: '$argon2id$real',
        });
  const query = jest.fn((sql: string) => {
    if (sql.includes('password_hash FROM users')) {
      return Promise.resolve(user ? [user] : []);
    }
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve(
        options.lockedStatus === null
          ? []
          : [
              {
                id: USER,
                email: EMAIL,
                status: options.lockedStatus ?? 'active',
              },
            ],
      );
    }
    return Promise.resolve([]);
  });
  const manager = { query } as unknown as EntityManager;
  const db = {
    manager,
    query,
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager),
  } as unknown as DataSource;
  const config = {
    get: (key: string) =>
      ({
        LOGIN_EMAIL_CONFIRMATION_ENABLED: options.confirm ?? false,
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
        LOG_PSEUDONYM_HMAC_KEY: KEY,
      })[key],
  } as unknown as ConfigService;
  const hasher = {
    hash: jest.fn().mockResolvedValue('$argon2id$dummy'),
    verify: jest.fn().mockResolvedValue(options.passwordOk ?? true),
  };
  const tokens = { issuePair: jest.fn().mockReturnValue(PAIR) };
  const engine = {
    findUserId: jest
      .fn()
      .mockResolvedValue(options.owner === undefined ? USER : options.owner),
    issue: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    confirm: jest
      .fn()
      .mockResolvedValue({ ok: true, value: { id: ATTEMPT, userId: USER } }),
    resend: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    claim: jest.fn().mockResolvedValue(true),
    deliver: jest.fn().mockResolvedValue(undefined),
    accepted: jest.fn().mockReturnValue({ confirmationRequired: true }),
  };
  const limiter = {
    consume: jest.fn().mockResolvedValue({
      allowed: options.allowed ?? true,
      retryAfterSeconds: options.allowed === false ? 42 : 0,
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LoginService(
    db,
    config,
    hasher as unknown as PasswordHasher,
    tokens as unknown as TokenService,
    engine as unknown as ChallengeEngine,
    limiter as unknown as RateLimiter,
  );
  return { service, query, hasher, tokens, engine, limiter };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return 'resolved';
}

const LOGIN = { email: EMAIL, password: 'correct horse 1' };

describe('LoginService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('login()', () => {
    it('prepares a dummy hash at startup with the real hasher', async () => {
      const { service, hasher } = setup({ user: null });
      await service.onModuleInit();

      expect(hasher.hash).toHaveBeenCalledTimes(1);
      await codeOf(() => service.login(LOGIN, '203.0.113.1'));
      expect(hasher.verify).toHaveBeenCalledWith(
        '$argon2id$dummy',
        LOGIN.password,
      );
    });

    it('signs a pair for an active user and gives back the failure slot', async () => {
      const { service, limiter, tokens } = setup();

      expect(await service.login(LOGIN, '203.0.113.1')).toEqual({
        kind: 'session',
        pair: PAIR,
      });
      expect(limiter.consume).toHaveBeenCalledWith('login_failures', [
        EMAIL,
        '203.0.113.1',
      ]);
      expect(limiter.release).toHaveBeenCalledWith('login_failures', [
        EMAIL,
        '203.0.113.1',
      ]);
      expect(tokens.issuePair).toHaveBeenCalledWith(USER);
    });

    it('refuses before any hash check when the failure limit is used up', async () => {
      const { service, hasher } = setup({ allowed: false });

      await expect(service.login(LOGIN, '203.0.113.1')).rejects.toMatchObject({
        code: 'too_many_requests',
        extras: { retryAfterSeconds: 42 },
      });
      expect(hasher.verify).not.toHaveBeenCalled();
    });

    it.each<[string, Parameters<typeof setup>[0]]>([
      ['an unknown email', { user: null }],
      ['a wrong password', { passwordOk: false }],
      [
        'a blocked user',
        {
          user: {
            id: USER,
            email: EMAIL,
            status: 'blocked',
            password_hash: 'h',
          },
        },
      ],
      [
        'a deleted user without a hash',
        {
          user: {
            id: USER,
            email: EMAIL,
            status: 'deleted',
            password_hash: null,
          },
        },
      ],
    ])(
      'answers %s with 401 invalid_credentials and keeps the slot',
      async (_name, options) => {
        const { service, hasher, limiter } = setup(options);

        expect(await codeOf(() => service.login(LOGIN, '203.0.113.1'))).toBe(
          'invalid_credentials',
        );
        expect(hasher.verify).toHaveBeenCalledTimes(1);
        expect(limiter.release).not.toHaveBeenCalled();
      },
    );

    it('logs an unknown email as a pseudonym only', async () => {
      const { service } = setup({ user: null });

      await codeOf(() => service.login(LOGIN, '203.0.113.1'));

      const fields = (warn.mock.calls as unknown[][])[0][0] as Record<
        string,
        unknown
      >;
      expect(fields).toMatchObject({ event: 'login', reason: 'unknown_email' });
      expect(fields.emailPseudonym).toEqual(expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(EMAIL);
    });

    it('starts a challenge when confirmation is on: 202 body, mail after the transaction', async () => {
      const { service, engine, tokens } = setup({ confirm: true });

      expect(await service.login(LOGIN, '203.0.113.1')).toEqual({
        kind: 'challenge',
        body: { confirmationRequired: true },
      });
      expect(engine.issue).toHaveBeenCalledWith(expect.anything(), 'login', {
        userId: USER,
        method: 'otp',
      });
      expect(engine.deliver).toHaveBeenCalledWith(EMAIL, issued);
      expect(tokens.issuePair).not.toHaveBeenCalled();
    });

    it('refuses with 401 when the user stopped being active before the lock', async () => {
      const { service, engine } = setup({
        confirm: true,
        lockedStatus: 'blocked',
      });

      expect(await codeOf(() => service.login(LOGIN, '203.0.113.1'))).toBe(
        'invalid_credentials',
      );
      expect(engine.issue).not.toHaveBeenCalled();
      expect(engine.deliver).not.toHaveBeenCalled();
    });

    it('passes the cooldown refusal on, without mail', async () => {
      const { service, engine } = setup({ confirm: true });
      engine.issue.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('resend_cooldown', 'cooldown', {
          retryAfterSeconds: 30,
        }),
      });

      expect(await codeOf(() => service.login(LOGIN, '203.0.113.1'))).toBe(
        'resend_cooldown',
      );
      expect(engine.deliver).not.toHaveBeenCalled();
    });
  });

  describe('confirm()', () => {
    it('signs, claims and returns the pair for a matching code', async () => {
      const { service, engine, tokens } = setup();

      expect(
        await service.confirm({ attemptId: ATTEMPT, code: '123456' }),
      ).toBe(PAIR);
      expect(engine.confirm).toHaveBeenCalledWith(expect.anything(), 'login', {
        challengeId: ATTEMPT,
        code: '123456',
        userId: USER,
        userEligible: true,
      });
      expect(tokens.issuePair).toHaveBeenCalledWith(USER);
      expect(engine.claim).toHaveBeenCalledWith(
        expect.anything(),
        'login',
        ATTEMPT,
        'confirmed',
      );
    });

    it('confirms a magic link by token', async () => {
      const { service, engine } = setup();

      await service.confirm({ token: `${ATTEMPT}.secret` });

      expect(engine.confirm).toHaveBeenCalledWith(
        expect.anything(),
        'login',
        expect.objectContaining({ token: `${ATTEMPT}.secret` }),
      );
    });

    it('answers an attempt that does not exist with 400 invalid_challenge', async () => {
      const { service } = setup({ owner: null });

      expect(
        await codeOf(() =>
          service.confirm({ attemptId: ATTEMPT, code: '123456' }),
        ),
      ).toBe('invalid_challenge');
    });

    it('marks a missing user as not eligible', async () => {
      const { service, engine } = setup({ lockedStatus: null });
      engine.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('invalid_challenge', 'user_inactive'),
      });

      expect(
        await codeOf(() =>
          service.confirm({ attemptId: ATTEMPT, code: '123456' }),
        ),
      ).toBe('invalid_credentials');
      expect(engine.confirm).toHaveBeenCalledWith(
        expect.anything(),
        'login',
        expect.objectContaining({ userEligible: false }),
      );
    });

    it('passes other engine refusals on unchanged', async () => {
      const { service, engine, tokens } = setup();
      engine.confirm.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected(
          'attempts_exhausted',
          'consumed:attempts_exhausted',
        ),
      });

      expect(
        await codeOf(() =>
          service.confirm({ attemptId: ATTEMPT, code: '123456' }),
        ),
      ).toBe('attempts_exhausted');
      expect(tokens.issuePair).not.toHaveBeenCalled();
    });

    it('answers a lost claim (a concurrent confirm) with 400', async () => {
      const { service, engine } = setup();
      engine.claim.mockResolvedValueOnce(false);

      expect(
        await codeOf(() =>
          service.confirm({ attemptId: ATTEMPT, code: '123456' }),
        ),
      ).toBe('invalid_challenge');
    });

    it('does not claim when signing fails, so the code can be tried again', async () => {
      const { service, engine, tokens } = setup();
      tokens.issuePair.mockImplementationOnce(() => {
        throw new AppException('service_unavailable');
      });

      expect(
        await codeOf(() =>
          service.confirm({ attemptId: ATTEMPT, code: '123456' }),
        ),
      ).toBe('service_unavailable');
      expect(engine.claim).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, string>]>([
      ['nothing', {}],
      ['both variants', { attemptId: ATTEMPT, code: '123456', token: 'x.y' }],
      ['an attempt without a code', { attemptId: ATTEMPT }],
      ['a code without an attempt', { code: '123456' }],
    ])('refuses %s with 400 validation_failed', async (_name, dto) => {
      const { service } = setup();

      expect(await codeOf(() => service.confirm(dto))).toBe(
        'validation_failed',
      );
    });
  });

  describe('resend()', () => {
    it('resends to the locked user and returns the 202 body', async () => {
      const { service, engine } = setup();

      expect(await service.resend({ attemptId: ATTEMPT })).toEqual({
        confirmationRequired: true,
      });
      expect(engine.resend).toHaveBeenCalledWith(expect.anything(), 'login', {
        challengeId: ATTEMPT,
        userId: USER,
        userEligible: true,
      });
      expect(engine.deliver).toHaveBeenCalledWith(EMAIL, issued);
    });

    it('answers an attempt that does not exist with 400', async () => {
      const { service } = setup({ owner: null });

      expect(await codeOf(() => service.resend({ attemptId: ATTEMPT }))).toBe(
        'invalid_challenge',
      );
    });

    it('answers a user who is no longer active with 401 invalid_credentials (D42)', async () => {
      const { service, engine } = setup({ lockedStatus: 'blocked' });
      engine.resend.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('invalid_challenge', 'user_inactive'),
      });

      expect(await codeOf(() => service.resend({ attemptId: ATTEMPT }))).toBe(
        'invalid_credentials',
      );
      expect(engine.deliver).not.toHaveBeenCalled();
    });

    it('passes the cooldown on', async () => {
      const { service, engine } = setup();
      engine.resend.mockResolvedValueOnce({
        ok: false,
        error: new ChallengeRejected('resend_cooldown', 'cooldown'),
      });

      expect(await codeOf(() => service.resend({ attemptId: ATTEMPT }))).toBe(
        'resend_cooldown',
      );
    });
  });
});
