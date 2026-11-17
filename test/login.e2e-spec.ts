import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppConfig } from '@/core/config/config.types';

import {
  ageLoginChallenges,
  codeFrom,
  createUser,
  decodeJwt,
  ip,
  loginChallenges,
  PASSWORD,
  send,
  setStatus,
  tokenFrom,
} from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import {
  countMail,
  hasMail,
  waitForMail,
  waitForMailCount,
} from './utils/mailpit';
import { resetRateLimits } from './utils/rate-limits';

/**
 * Spec 1.2 §1.3.1–1.3.2, through HTTP: direct login, the OTP and magic-link second step, resend,
 * user statuses, the login rate limits and CSRF. Confirmation is off in .env.test; the suites
 * below turn it on per app.
 */

const sent: string[] = [PASSWORD];
const remember = <T extends string>(value: T): T => {
  sent.push(value);
  return value;
};

const INACTIVE = ['pending', 'blocked', 'deleting', 'deleted'] as const;

describe('Login without confirmation (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({ logs }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  it('signs in an active user: 204, no body, an access and a refresh cookie', async () => {
    const user = await createUser(app);
    remember(user.email);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
    expect([...res.cookies.keys()].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    remember(res.cookies.get('access_token')!.value);
    remember(res.cookies.get('refresh_token')!.value);
  });

  it('normalizes the email: outer spaces and case do not matter', async () => {
    const user = await createUser(app);
    remember(user.email);

    const res = await send(app, '/auth/login', {
      body: { email: `  ${user.email.toUpperCase()}  `, password: PASSWORD },
    });

    expect(res.status).toBe(204);
  });

  it('does not trim or normalize the password', async () => {
    const user = await createUser(app, { password: '  spaced pass 1 ' });
    remember(user.email);

    const trimmed = await send(app, '/auth/login', {
      body: { email: user.email, password: 'spaced pass 1' },
    });
    const exact = await send(app, '/auth/login', {
      body: { email: user.email, password: '  spaced pass 1 ' },
    });

    expect(trimmed.status).toBe(401);
    expect(exact.status).toBe(204);
  });

  it('issues HS256 tokens with exactly the spec claims (no jti, roles or email)', async () => {
    const user = await createUser(app);
    remember(user.email);
    const before = Math.floor(Date.now() / 1000);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    const access = decodeJwt(res.cookies.get('access_token')!.value);
    const refresh = decodeJwt(res.cookies.get('refresh_token')!.value);

    for (const token of [access, refresh]) {
      expect(token.header).toEqual({ alg: 'HS256', typ: 'JWT' });
      expect(Object.keys(token.payload).sort()).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'sub', 'token_use'].sort(),
      );
      expect(token.payload).toMatchObject({
        sub: user.id,
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
      });
      expect(token.payload.iat).toBeGreaterThanOrEqual(before);
    }
    const iat = access.payload.iat as number;
    expect(access.payload).toMatchObject({
      token_use: 'access',
      exp: iat + 900,
    });
    expect(refresh.payload).toMatchObject({
      token_use: 'refresh',
      exp: (refresh.payload.iat as number) + 2_592_000,
    });
  });

  it('sets the cookie attributes of spec 1.2 §1.3.3 (Secure off only in .env.test)', async () => {
    const user = await createUser(app);
    remember(user.email);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    const access = res.cookies.get('access_token')!;
    const refresh = res.cookies.get('refresh_token')!;

    expect(access.attributes.get('path')).toBe('/');
    expect(access.attributes.get('max-age')).toBe('900');
    expect(refresh.attributes.get('path')).toBe('/auth/refresh');
    expect(refresh.attributes.get('max-age')).toBe('2592000');
    for (const cookie of [access, refresh]) {
      expect(cookie.attributes.has('httponly')).toBe(true);
      expect(cookie.attributes.get('samesite')).toBe('Strict');
      expect(cookie.attributes.has('domain')).toBe(false);
    }
  });

  describe('one generic 401 invalid_credentials', () => {
    const bodyOf = (res: { body: Record<string, unknown> }) => {
      const { requestId, ...rest } = res.body;
      expect(requestId).toEqual(expect.any(String));
      return rest;
    };

    it('answers an unknown email, a wrong password and every non-active status identically', async () => {
      const known = await createUser(app);
      remember(known.email);
      const answers = [
        await send(app, '/auth/login', {
          body: {
            email: remember(`nobody-${randomUUID()}@example.com`),
            password: PASSWORD,
          },
        }),
        await send(app, '/auth/login', {
          body: { email: known.email, password: 'wrong horse 2' },
        }),
      ];
      for (const status of INACTIVE) {
        const user = await createUser(app);
        remember(user.email);
        await setStatus(app, user.id, status);
        answers.push(
          await send(app, '/auth/login', {
            body: { email: user.email, password: PASSWORD },
          }),
        );
      }

      const expected = {
        statusCode: 401,
        code: 'invalid_credentials',
        message: 'Invalid email or password.',
      };
      for (const res of answers) {
        expect(res.status).toBe(401);
        expect(bodyOf(res)).toEqual(expected);
        expect(res.cookies.size).toBe(0);
      }
    });

    it.each(INACTIVE)(
      'refuses a %s user even with the right password',
      async (status) => {
        const user = await createUser(app);
        remember(user.email);
        await setStatus(app, user.id, status);

        const res = await send(app, '/auth/login', {
          body: { email: user.email, password: PASSWORD },
        });

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_credentials');
      },
    );
  });

  describe('request format: 400 before any password check', () => {
    it.each<[string, Record<string, unknown>]>([
      ['no email', { password: PASSWORD }],
      ['no password', { email: 'a@example.com' }],
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
      ['an empty password', { email: 'a@example.com', password: '' }],
      ['a numeric password', { email: 'a@example.com', password: 12345678 }],
      [
        'an over-long password',
        { email: 'a@example.com', password: 'a1'.repeat(65) },
      ],
      [
        'an unknown field',
        { email: 'a@example.com', password: PASSWORD, role: 'admin' },
      ],
    ])('answers %s with 400 validation_failed', async (_name, body) => {
      const res = await send(app, '/auth/login', { body });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.cookies.size).toBe(0);
    });
  });

  describe('rate limits (spec 1.2 §1.6)', () => {
    it('allows 5 failed checks per email and IP in 15 minutes; the 6th is 429, even with the right password', async () => {
      const user = await createUser(app);
      remember(user.email);
      const from = ip();

      for (let i = 0; i < 5; i++) {
        const res = await send(app, '/auth/login', {
          body: { email: user.email, password: 'wrong horse 2' },
          remoteAddress: from,
        });
        expect(res.status).toBe(401);
      }
      const blocked = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
        remoteAddress: from,
      });

      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('too_many_requests');
      expect(blocked.body.retryAfterSeconds).toEqual(expect.any(Number));
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.cookies.size).toBe(0);
    });

    it('keys the failure limit by email and IP: another IP or another email still gets through', async () => {
      const user = await createUser(app);
      const other = await createUser(app);
      remember(user.email);
      remember(other.email);
      const from = ip();
      for (let i = 0; i < 5; i++) {
        await send(app, '/auth/login', {
          body: { email: user.email, password: 'wrong horse 2' },
          remoteAddress: from,
        });
      }

      const otherIp = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
      });
      const otherEmail = await send(app, '/auth/login', {
        body: { email: other.email, password: PASSWORD },
        remoteAddress: from,
      });

      expect(otherIp.status).toBe(204);
      expect(otherEmail.status).toBe(204);
    });

    it('counts unknown emails too, so the limit does not reveal which emails exist', async () => {
      const email = remember(`nobody-${randomUUID()}@example.com`);
      const from = ip();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push(
          (
            await send(app, '/auth/login', {
              body: { email, password: PASSWORD },
              remoteAddress: from,
            })
          ).status,
        );
      }

      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('does not count successful logins', async () => {
      const user = await createUser(app);
      remember(user.email);
      const from = ip();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await send(app, '/auth/login', {
              body: { email: user.email, password: 'wrong horse 2' },
              remoteAddress: from,
            })
          ).status,
        );
      }
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (
            await send(app, '/auth/login', {
              body: { email: user.email, password: PASSWORD },
              remoteAddress: from,
            })
          ).status,
        );
      }
      statuses.push(
        (
          await send(app, '/auth/login', {
            body: { email: user.email, password: 'wrong horse 2' },
            remoteAddress: from,
          })
        ).status,
      );

      expect(statuses).toEqual([401, 401, 401, 401, 204, 204, 204, 401]);
    });

    it('allows 30 login requests per IP per minute; the 31st is 429', async () => {
      const from = ip();
      for (let i = 0; i < 30; i++) {
        // Malformed bodies: the IP limit counts every request and they skip the slow hash.
        const res = await send(app, '/auth/login', {
          body: { email: 'not-an-email' },
          remoteAddress: from,
        });
        expect(res.status).toBe(400);
      }
      const res = await send(app, '/auth/login', {
        body: { email: 'not-an-email' },
        remoteAddress: from,
      });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('too_many_requests');
    });
  });

  describe('CSRF (spec 1.2 §1.3.3)', () => {
    it('refuses a login from an untrusted origin with 403 csrf_rejected and no cookies', async () => {
      const user = await createUser(app);
      remember(user.email);

      const res = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
        headers: { origin: 'https://evil.example' },
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('csrf_rejected');
      expect(res.cookies.size).toBe(0);
    });

    it('refuses a trusted cross-origin login without X-CSRF-Protection: 1', async () => {
      const user = await createUser(app);
      remember(user.email);

      const res = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
        headers: { origin: config.CORS_ORIGINS[0] },
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('csrf_rejected');
    });

    it('accepts a trusted cross-origin login with the header', async () => {
      const user = await createUser(app);
      remember(user.email);

      const res = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
        headers: { origin: config.CORS_ORIGINS[0], 'x-csrf-protection': '1' },
      });

      expect(res.status).toBe(204);
    });
  });

  it('logs the outcome by user id, and an unknown email only as a pseudonym', async () => {
    const user = await createUser(app);
    remember(user.email);
    const unknown = remember(`nobody-${randomUUID()}@example.com`);
    logs.clear();

    await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    await send(app, '/auth/login', {
      body: { email: unknown, password: PASSWORD },
    });

    const events = logs.lines().filter((line) => line.context === 'Auth');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'login',
          result: 'success',
          userId: user.id,
        }),
        expect.objectContaining({
          event: 'login',
          result: 'failure',
          reason: 'unknown_email',
          emailPseudonym: expect.any(String) as string,
        }),
      ]),
    );
    expect(logs.text()).not.toContain(unknown);
  });
});

describe('Login with OTP confirmation (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      logs,
      env: {
        LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
      },
    }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  async function startLogin() {
    const user = await createUser(app);
    remember(user.email);
    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    const mail = await waitForMail(user.email);
    return {
      user,
      res,
      attemptId: res.body.attemptId as string,
      code: remember(codeFrom(mail.text)),
    };
  }

  it('answers a correct password with 202 and the attempt, no cookies, and mails a code', async () => {
    const { res, user, code } = await startLogin();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      confirmationRequired: true,
      method: 'otp',
      attemptId: expect.any(String) as string,
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
    expect(res.cookies.size).toBe(0);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);
    expect(await loginChallenges(app, user.id)).toHaveLength(1);
  });

  it('sends nothing for a wrong password: 401, no challenge, no mail', async () => {
    const user = await createUser(app);
    remember(user.email);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: 'wrong horse 2' },
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_credentials');
    expect(await loginChallenges(app, user.id)).toHaveLength(0);
    expect(await hasMail(user.email)).toBe(false);
  });

  it('sends nothing for a non-active user', async () => {
    const user = await createUser(app, { status: 'blocked' });
    remember(user.email);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(401);
    expect(await loginChallenges(app, user.id)).toHaveLength(0);
  });

  it('confirms with the code: 204 and both cookies; the attempt is then consumed', async () => {
    const { user, attemptId, code } = await startLogin();

    const res = await send(app, '/auth/login/confirm', {
      body: { attemptId, code },
    });

    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
    expect([...res.cookies.keys()].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    remember(res.cookies.get('access_token')!.value);
    expect(decodeJwt(res.cookies.get('access_token')!.value).payload.sub).toBe(
      user.id,
    );
    expect(await loginChallenges(app, user.id)).toEqual([
      expect.objectContaining({ consumed_reason: 'confirmed' }),
    ]);

    const again = await send(app, '/auth/login/confirm', {
      body: { attemptId, code },
    });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('invalid_challenge');
  });

  it('checks the 5th attempt: four wrong codes, then the right one still signs in', async () => {
    const { attemptId, code } = await startLogin();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 4; i++) {
      const res = await send(app, '/auth/login/confirm', {
        body: { attemptId, code: wrong },
      });
      expect(res.status).toBe(400);
    }
    const fifth = await send(app, '/auth/login/confirm', {
      body: { attemptId, code },
    });

    expect(fifth.status).toBe(204);
  });

  it('exhausts after five wrong codes: the 5th is 400, the next is 429 attempts_exhausted', async () => {
    const { user, attemptId, code } = await startLogin();
    const wrong = code === '000000' ? '111111' : '000000';

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (
          await send(app, '/auth/login/confirm', {
            body: { attemptId, code: wrong },
          })
        ).status,
      );
    }
    const next = await send(app, '/auth/login/confirm', {
      body: { attemptId, code },
    });

    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    expect(next.status).toBe(429);
    expect(next.body.code).toBe('attempts_exhausted');
    expect(await loginChallenges(app, user.id)).toEqual([
      expect.objectContaining({
        attempts: 5,
        consumed_reason: 'attempts_exhausted',
      }),
    ]);
  });

  it('expires 10 minutes after the mail, without counting the attempt', async () => {
    const { user, attemptId, code } = await startLogin();
    await ageLoginChallenges(app, user.id, 601);

    const res = await send(app, '/auth/login/confirm', {
      body: { attemptId, code },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_challenge');
    expect((await loginChallenges(app, user.id))[0].attempts).toBe(0);
  });

  it.each(['blocked', 'deleting'])(
    'refuses a user who became %s before confirming: 401 invalid_credentials, then 400',
    async (status) => {
      const { user, attemptId, code } = await startLogin();
      await setStatus(app, user.id, status);

      const res = await send(app, '/auth/login/confirm', {
        body: { attemptId, code },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(res.cookies.size).toBe(0);
      expect(await loginChallenges(app, user.id)).toEqual([
        expect.objectContaining({ consumed_reason: 'user_inactive' }),
      ]);

      await setStatus(app, user.id, 'active');
      const later = await send(app, '/auth/login/confirm', {
        body: { attemptId, code },
      });
      expect(later.status).toBe(400);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['an unknown attempt', { attemptId: randomUUID(), code: '123456' }],
  ])('answers %s with 400 invalid_challenge', async (_name, body) => {
    const res = await send(app, '/auth/login/confirm', { body });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_challenge');
  });

  it.each<[string, Record<string, unknown>]>([
    ['nothing', {}],
    ['a code without an attempt', { code: '123456' }],
    ['an attempt without a code', { attemptId: randomUUID() }],
    ['a five-digit code', { attemptId: randomUUID(), code: '12345' }],
    ['a code with letters', { attemptId: randomUUID(), code: '12a456' }],
    ['a malformed attempt id', { attemptId: 'abc', code: '123456' }],
    [
      'both variants',
      { attemptId: randomUUID(), code: '123456', token: 'x.y' },
    ],
  ])('answers %s with 400 validation_failed', async (_name, body) => {
    const res = await send(app, '/auth/login/confirm', { body });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  describe('a new login while an attempt is outstanding', () => {
    it('within 60 s of the mail: 429 resend_cooldown with the remaining seconds, no new mail', async () => {
      const { user } = await startLogin();

      const res = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
      });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('resend_cooldown');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(await loginChallenges(app, user.id)).toHaveLength(1);
      expect(await countMail(user.email)).toBe(1);
    });

    it('after 60 s: a new attempt replaces the old one, whose code stops working', async () => {
      const { user, attemptId, code } = await startLogin();
      await ageLoginChallenges(app, user.id, 61);

      const res = await send(app, '/auth/login', {
        body: { email: user.email, password: PASSWORD },
      });
      const mail = await waitForMailCount(user.email, 2);
      const newCode = remember(codeFrom(mail.text));

      expect(res.status).toBe(202);
      expect(res.body.attemptId).not.toBe(attemptId);
      const old = await send(app, '/auth/login/confirm', {
        body: { attemptId, code },
      });
      expect(old.status).toBe(400);
      expect(
        (await loginChallenges(app, user.id)).map((c) => c.consumed_reason),
      ).toEqual(['replaced', null]);
      const fresh = await send(app, '/auth/login/confirm', {
        body: { attemptId: res.body.attemptId, code: newCode },
      });
      expect(fresh.status).toBe(204);
    });
  });

  describe('resend', () => {
    it('within 60 s: 429 resend_cooldown with the remaining seconds', async () => {
      const { attemptId } = await startLogin();

      const res = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('resend_cooldown');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('after 60 s: 202 with the same attempt and method; the old code stops working, the new one signs in', async () => {
      const { user, attemptId, code } = await startLogin();
      await ageLoginChallenges(app, user.id, 61);

      const res = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });
      const mail = await waitForMailCount(user.email, 2);
      const newCode = remember(codeFrom(mail.text));

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      if (newCode !== code) {
        const old = await send(app, '/auth/login/confirm', {
          body: { attemptId, code },
        });
        expect(old.status).toBe(400);
      }
      const fresh = await send(app, '/auth/login/confirm', {
        body: { attemptId, code: newCode },
      });
      expect(fresh.status).toBe(204);
    });

    it('resets the attempt counter', async () => {
      const { user, attemptId, code } = await startLogin();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i++) {
        await send(app, '/auth/login/confirm', {
          body: { attemptId, code: wrong },
        });
      }
      await ageLoginChallenges(app, user.id, 61);

      await send(app, '/auth/login/resend', { body: { attemptId } });

      expect((await loginChallenges(app, user.id))[0].attempts).toBe(0);
    });

    it('works after the code expired (the TTL stops confirmation, not resend)', async () => {
      const { user, attemptId } = await startLogin();
      await ageLoginChallenges(app, user.id, 700);

      const res = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });

      expect(res.status).toBe(202);
      remember(codeFrom((await waitForMailCount(user.email, 2)).text));
    });

    it('refuses an exhausted attempt with 429 attempts_exhausted', async () => {
      const { user, attemptId, code } = await startLogin();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await send(app, '/auth/login/confirm', {
          body: { attemptId, code: wrong },
        });
      }
      await ageLoginChallenges(app, user.id, 61);

      const res = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('attempts_exhausted');
    });

    it('refuses a confirmed attempt and an unknown one with 400 invalid_challenge', async () => {
      const { user, attemptId, code } = await startLogin();
      await send(app, '/auth/login/confirm', { body: { attemptId, code } });
      await ageLoginChallenges(app, user.id, 61);

      const confirmed = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });
      const unknown = await send(app, '/auth/login/resend', {
        body: { attemptId: randomUUID() },
      });

      expect(confirmed.status).toBe(400);
      expect(confirmed.body.code).toBe('invalid_challenge');
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('invalid_challenge');
    });

    it('refuses a user who is no longer active with 401 invalid_credentials (D42)', async () => {
      const { user, attemptId } = await startLogin();
      await setStatus(app, user.id, 'blocked');
      await ageLoginChallenges(app, user.id, 61);

      const res = await send(app, '/auth/login/resend', {
        body: { attemptId },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(await countMail(user.email)).toBe(1);
    });

    it.each<[string, Record<string, unknown>]>([
      ['nothing', {}],
      ['a malformed attempt id', { attemptId: 'abc' }],
    ])('answers %s with 400 validation_failed', async (_name, body) => {
      const res = await send(app, '/auth/login/resend', { body });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  it('keeps the method of an attempt created before the setting changed', async () => {
    const { user, attemptId } = await startLogin();
    const { app: linkApp } = await createTestApp({
      env: {
        LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link',
      },
    });
    try {
      await ageLoginChallenges(app, user.id, 61);
      const res = await send(linkApp, '/auth/login/resend', {
        body: { attemptId },
      });
      expect(res.status).toBe(202);
      expect(res.body.method).toBe('otp');
      remember(codeFrom((await waitForMailCount(user.email, 2)).text));
    } finally {
      await linkApp.close();
    }
  });

  it('logs creation, confirmation and failures with the attempt id, never the code', async () => {
    const { user, attemptId, code } = await startLogin();
    await send(app, '/auth/login/confirm', { body: { attemptId, code } });

    const events = logs.lines().filter((line) => line.context === 'Auth');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'login_challenge',
          result: 'created',
          userId: user.id,
          attemptId,
          method: 'otp',
        }),
        expect.objectContaining({
          event: 'login_confirm',
          result: 'success',
          userId: user.id,
          attemptId,
        }),
      ]),
    );
  });
});

describe('Login with magic-link confirmation (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      logs,
      env: {
        LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link',
      },
    }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  async function startLogin() {
    const user = await createUser(app);
    remember(user.email);
    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    const mail = await waitForMail(user.email);
    return { user, res, token: remember(tokenFrom(mail.text)) };
  }

  it('mails a link whose fragment carries attemptId.secret; confirming it signs in', async () => {
    const { res, token } = await startLogin();

    expect(res.status).toBe(202);
    expect(res.body.method).toBe('magic_link');
    const [attemptId, secret] = token.split('.');
    expect(attemptId).toBe(res.body.attemptId);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);

    const confirmed = await send(app, '/auth/login/confirm', {
      body: { token },
    });
    expect(confirmed.status).toBe(204);
    expect(confirmed.cookies.has('access_token')).toBe(true);
    expect(confirmed.cookies.has('refresh_token')).toBe(true);
  });

  it('refuses a wrong secret with 400 and counts no attempt', async () => {
    const { user, token } = await startLogin();
    const [attemptId] = token.split('.');
    const forged = `${attemptId}.${Buffer.alloc(32).toString('base64url')}`;

    for (let i = 0; i < 6; i++) {
      const res = await send(app, '/auth/login/confirm', {
        body: { token: forged },
      });
      expect(res.status).toBe(400);
    }

    expect((await loginChallenges(app, user.id))[0]).toMatchObject({
      attempts: 0,
      consumed_reason: null,
    });
    const real = await send(app, '/auth/login/confirm', { body: { token } });
    expect(real.status).toBe(204);
  });

  it('refuses an OTP for a magic-link attempt', async () => {
    const { token } = await startLogin();
    const [attemptId] = token.split('.');

    const res = await send(app, '/auth/login/confirm', {
      body: { attemptId, code: '123456' },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_challenge');
  });

  it('answers a malformed token with 400', async () => {
    const res = await send(app, '/auth/login/confirm', {
      body: { token: 'not-a-token' },
    });

    expect(res.status).toBe(400);
  });
});

describe('Login confirmation when SMTP is down (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true', SMTP_PORT: '1' },
    }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the attempt and answers 503 with the safe fields and no secret', async () => {
    const user = await createUser(app);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'service_unavailable',
      confirmationRequired: true,
      method: 'otp',
      attemptId: expect.any(String) as string,
      retryAfterSeconds: 60,
    });
    expect(res.cookies.size).toBe(0);
    const challenges = await loginChallenges(app, user.id);
    expect(challenges).toEqual([
      expect.objectContaining({
        id: res.body.attemptId,
        consumed_reason: null,
      }),
    ]);
  });

  it('answers resend 503 too, keeping the new secret', async () => {
    const user = await createUser(app);
    const first = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    await ageLoginChallenges(app, user.id, 61);

    const res = await send(app, '/auth/login/resend', {
      body: { attemptId: first.body.attemptId },
    });

    expect(res.status).toBe(503);
    expect(res.body.attemptId).toBe(first.body.attemptId);
  });
});

describe('Cross-site cookies (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'true' },
    }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets SameSite=None; Secure on both cookies when COOKIE_SAME_SITE=none', async () => {
    const user = await createUser(app);

    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(204);
    for (const name of ['access_token', 'refresh_token']) {
      const cookie = res.cookies.get(name)!;
      expect(cookie.attributes.get('samesite')).toBe('None');
      expect(cookie.attributes.has('secure')).toBe(true);
      expect(cookie.attributes.has('httponly')).toBe(true);
      expect(cookie.attributes.has('domain')).toBe(false);
    }
  });
});
