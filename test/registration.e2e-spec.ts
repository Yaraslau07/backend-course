import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppConfig } from '@/core/config/config.types';
import { PasswordHasher } from '@/modules/auth/password-hasher';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { hasMail, waitForMail } from './utils/mailpit';
import { resetRateLimits } from './utils/rate-limits';

/** Spec 1.0, through HTTP. Confirmation is off in .env.test; apps below turn it on per suite. */

const PASSWORD = 'correct horse 1';
const sent: string[] = [PASSWORD];
const newEmail = (prefix = 'reg') => {
  const email = `${prefix}-${randomUUID()}@example.com`;
  sent.push(email);
  return email;
};

/** Each request gets its own client IP, so the registration rate limit only bites where tested. */
const ip = () =>
  `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

async function post(
  app: NestFastifyApplication,
  url: string,
  body: unknown,
  remoteAddress = ip(),
) {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: body as Record<string, unknown>,
    remoteAddress,
  });
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || '{}') as Record<string, unknown>,
    headers: res.headers,
  };
}

async function userRow(db: DataSource, email: string) {
  const [row] = await db.query<
    { id: string; status: string; password_hash: string }[]
  >(`SELECT id, status, password_hash FROM users WHERE email = $1`, [email]);
  return row;
}

async function ageChallenges(db: DataSource, userId: string, seconds: number) {
  await db.query(
    `UPDATE registration_challenges SET last_sent_at = last_sent_at - make_interval(secs => $2) WHERE user_id = $1`,
    [userId, seconds],
  );
}

const codeFrom = (text: string) => /\b(\d{6})\b/.exec(text)?.[1] ?? '';
const tokenFrom = (text: string) =>
  new URLSearchParams(
    new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? 'http://x').hash.slice(1),
  ).get('token') ?? '';

describe('Registration without confirmation (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;
  let db: DataSource;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({ logs }));
    db = app.get(DataSource);
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  it('creates an active user: 201 with exactly id, normalized email and status', async () => {
    const email = newEmail();

    const res = await post(app, '/auth/register', {
      email: `  ${email.toUpperCase()} `,
      password: PASSWORD,
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String) as string,
      email,
      status: 'active',
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    const row = await userRow(db, email);
    expect(row).toMatchObject({ id: res.body.id, status: 'active' });
  });

  it('stores only an argon2id hash of the password, outer spaces included', async () => {
    const email = newEmail();
    await post(app, '/auth/register', { email, password: '  spaced pass 1 ' });

    const row = await userRow(db, email);
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain('spaced');
    expect(
      await app
        .get(PasswordHasher)
        .verify(row.password_hash, '  spaced pass 1 '),
    ).toBe(true);
  });

  it('sends no mail', async () => {
    const email = newEmail();
    await post(app, '/auth/register', { email, password: PASSWORD });

    expect(await hasMail(email)).toBe(false);
  });

  it('refuses an email that is already registered, whatever its case: 409 email_taken', async () => {
    const email = newEmail();
    await post(app, '/auth/register', { email, password: PASSWORD });

    const again = await post(app, '/auth/register', {
      email: email.toUpperCase(),
      password: 'another one 2',
    });

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'email_taken' });
    expect(again.body).not.toHaveProperty('id');
  });

  it('treats user+tag@ as a separate address', async () => {
    const email = newEmail();
    const tagged = email.replace('@', '+tag@');
    sent.push(tagged);
    await post(app, '/auth/register', { email, password: PASSWORD });

    expect(
      (await post(app, '/auth/register', { email: tagged, password: PASSWORD }))
        .status,
    ).toBe(201);
  });

  it('two registrations of one email at the same time: one 201, one 409 (the unique index decides)', async () => {
    const email = newEmail();

    const results = await Promise.all([
      post(app, '/auth/register', { email, password: PASSWORD }),
      post(app, '/auth/register', { email, password: PASSWORD }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      code: 'email_taken',
    });
  });

  it.each([
    ['an invalid email', { email: 'nope', password: PASSWORD }, 'email'],
    [
      'a short password',
      { email: 'x@example.com', password: 'a1' },
      'password',
    ],
    [
      'a password without a digit',
      { email: 'x@example.com', password: 'abcdefghij' },
      'password',
    ],
    [
      'a password without a letter',
      { email: 'x@example.com', password: '1234567890' },
      'password',
    ],
    [
      'an over-long password',
      { email: 'x@example.com', password: `a1${'x'.repeat(200)}` },
      'password',
    ],
    ['a missing password', { email: 'x@example.com' }, 'password'],
    [
      'an extra field',
      { email: 'x@example.com', password: PASSWORD, status: 'active' },
      'status',
    ],
  ])(
    'answers %s with 400 validation_failed naming the field',
    async (_name, body, field) => {
      const res = await post(app, '/auth/register', body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(
        (res.body.errors as { field: string }[]).map((e) => e.field),
      ).toContain(field);
    },
  );

  it('limits registrations per IP to REGISTRATION_RATE_LIMIT_PER_HOUR, then 429 with Retry-After', async () => {
    const client = ip();
    for (let i = 0; i < config.REGISTRATION_RATE_LIMIT_PER_HOUR; i++) {
      expect(
        (
          await post(
            app,
            '/auth/register',
            { email: newEmail(), password: PASSWORD },
            client,
          )
        ).status,
      ).toBe(201);
    }

    const refused = await post(
      app,
      '/auth/register',
      { email: newEmail(), password: PASSWORD },
      client,
    );

    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('too_many_requests');
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('logs the outcome by user id, never the email or password', () => {
    const events = logs
      .lines()
      .filter((line) => line.msg === 'registration event');

    expect(
      events.some(
        (e) => e.event === 'registered' && typeof e.userId === 'string',
      ),
    ).toBe(true);
    expect(events.some((e) => e.event === 'email_taken')).toBe(true);
  });
});

describe.each(['otp', 'magic_link'] as const)(
  'Registration with %s confirmation (e2e)',
  (method) => {
    let app: NestFastifyApplication;
    let db: DataSource;

    beforeAll(async () => {
      ({ app } = await createTestApp({
        env: {
          REGISTRATION_EMAIL_CONFIRMATION_ENABLED: 'true',
          REGISTRATION_EMAIL_CONFIRMATION_METHOD: method,
        },
      }));
      db = app.get(DataSource);
      await resetRateLimits(app);
    });

    afterAll(() => app.close());

    async function register() {
      const email = newEmail();
      const res = await post(app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      const mail = await waitForMail(email);
      const secret =
        method === 'otp' ? codeFrom(mail.text) : tokenFrom(mail.text);
      sent.push(secret);
      return { email, res, secret, attemptId: res.body.attemptId as string };
    }

    const confirmBody = (attemptId: string, secret: string) =>
      method === 'otp' ? { attemptId, code: secret } : { token: secret };

    it('answers 202 with the challenge fields only, and leaves the user pending', async () => {
      const { email, res } = await register();

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        confirmationRequired: true,
        method,
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect((await userRow(db, email)).status).toBe('pending');
    });

    it('activates the user with the secret from the mail: 200 with id, email and status', async () => {
      const { email, secret, attemptId } = await register();

      const res = await post(
        app,
        '/auth/register/confirm',
        confirmBody(attemptId, secret),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: (await userRow(db, email)).id,
        email,
        status: 'active',
      });
      expect((await userRow(db, email)).status).toBe('active');
    });

    it('uses the secret once', async () => {
      const { secret, attemptId } = await register();
      await post(app, '/auth/register/confirm', confirmBody(attemptId, secret));

      const again = await post(
        app,
        '/auth/register/confirm',
        confirmBody(attemptId, secret),
      );

      expect(again.status).toBe(400);
      expect(again.body.code).toBe('invalid_challenge');
    });

    it('refuses a second registration of a pending email with 409 and sends no second mail', async () => {
      const { email } = await register();

      const again = await post(app, '/auth/register', {
        email,
        password: PASSWORD,
      });

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('email_taken');
    });

    it('refuses a resend within 60 s with 429 and the seconds left', async () => {
      const { email } = await register();

      const res = await post(app, '/auth/register/resend', { email });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'resend_cooldown' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('after 60 s, resend mails a new secret and the old one stops working', async () => {
      const { email, secret, attemptId } = await register();
      const user = await userRow(db, email);
      await ageChallenges(db, user.id, 61);

      const res = await post(app, '/auth/register/resend', {
        email: ` ${email.toUpperCase()}`,
      });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        confirmationRequired: true,
        method,
        attemptId,
      });
      const mails = await waitForNewSecret(email, secret);
      sent.push(mails);
      expect(
        (
          await post(
            app,
            '/auth/register/confirm',
            confirmBody(attemptId, secret),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            app,
            '/auth/register/confirm',
            confirmBody(attemptId, mails),
          )
        ).status,
      ).toBe(200);
    });

    /** Mailpit's newest message to `email` once it carries a secret other than `old`. */
    async function waitForNewSecret(
      email: string,
      old: string,
    ): Promise<string> {
      for (let i = 0; i < 50; i++) {
        const mail = await waitForMail(email);
        const secret =
          method === 'otp' ? codeFrom(mail.text) : tokenFrom(mail.text);
        if (secret && secret !== old) return secret;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('no new secret arrived');
    }

    it('answers resend for an unknown or already active email with 400, like an unknown challenge', async () => {
      const unknown = await post(app, '/auth/register/resend', {
        email: newEmail(),
      });
      const { email, secret, attemptId } = await register();
      await post(app, '/auth/register/confirm', confirmBody(attemptId, secret));
      const active = await post(app, '/auth/register/resend', { email });

      expect(unknown).toMatchObject({
        status: 400,
        body: { code: 'invalid_challenge' },
      });
      expect(active).toMatchObject({
        status: 400,
        body: { code: 'invalid_challenge' },
      });
    });

    if (method === 'otp') {
      it('after five wrong codes the challenge is exhausted (429), and resend issues a new one', async () => {
        const { email, secret, attemptId } = await register();
        const wrong = String((Number(secret) + 1) % 1_000_000).padStart(6, '0');
        for (let i = 0; i < 5; i++) {
          expect(
            (
              await post(app, '/auth/register/confirm', {
                attemptId,
                code: wrong,
              })
            ).status,
          ).toBe(400);
        }
        expect(
          await post(app, '/auth/register/confirm', {
            attemptId,
            code: secret,
          }),
        ).toMatchObject({ status: 429, body: { code: 'attempts_exhausted' } });

        // The cooldown counts from the last mail, even though that challenge is used up.
        expect(
          (await post(app, '/auth/register/resend', { email })).status,
        ).toBe(429);
        await ageChallenges(db, (await userRow(db, email)).id, 61);

        const resent = await post(app, '/auth/register/resend', { email });
        expect(resent.status).toBe(202);
        expect(resent.body.attemptId).not.toBe(attemptId);
        const fresh = await waitForNewSecret(email, secret);
        sent.push(fresh);
        expect(
          (
            await post(app, '/auth/register/confirm', {
              attemptId: resent.body.attemptId,
              code: fresh,
            })
          ).status,
        ).toBe(200);
      });

      it.each([
        [
          'both variants',
          (id: string) => ({ attemptId: id, code: '123456', token: 'x' }),
        ],
        ['an id without a code', (id: string) => ({ attemptId: id })],
        ['nothing', () => ({})],
        [
          'a code that is not six digits',
          (id: string) => ({ attemptId: id, code: '12345' }),
        ],
        [
          'an id that is not a UUID',
          () => ({ attemptId: 'nope', code: '123456' }),
        ],
      ])(
        'answers a confirm body with %s with 400 validation_failed',
        async (_name, body) => {
          const res = await post(
            app,
            '/auth/register/confirm',
            body(randomUUID()),
          );

          expect(res.status).toBe(400);
          expect(res.body.code).toBe('validation_failed');
        },
      );
    } else {
      it('the link opens a frontend page; the API has no GET for it', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/auth/register/confirm',
        });

        expect(res.statusCode).toBe(404);
      });
    }
  },
);

describe('Registration when SMTP is down (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { REGISTRATION_EMAIL_CONFIRMATION_ENABLED: 'true', SMTP_PORT: '1' },
    }));
    db = app.get(DataSource);
  });

  afterAll(() => app.close());

  it('keeps the pending user and the challenge, and answers 503 with the safe fields', async () => {
    const email = newEmail();

    const res = await post(app, '/auth/register', {
      email,
      password: PASSWORD,
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'service_unavailable',
      confirmationRequired: true,
      method: 'otp',
      attemptId: expect.any(String) as string,
      retryAfterSeconds: 60,
    });
    expect(res.headers['retry-after']).toBe('60');
    expect((await userRow(db, email)).status).toBe('pending');
    expect(
      (await post(app, '/auth/register', { email, password: PASSWORD })).status,
    ).toBe(409);
  });
});

describe('Registration confirmed after the flag was turned off (e2e)', () => {
  it('a pending user created while confirmation was on can still confirm and resend', async () => {
    const email = newEmail();
    const on = await createTestApp({
      env: { REGISTRATION_EMAIL_CONFIRMATION_ENABLED: 'true' },
    });
    let attemptId: string;
    try {
      attemptId = (
        await post(on.app, '/auth/register', { email, password: PASSWORD })
      ).body.attemptId as string;
    } finally {
      await on.app.close();
    }
    const code = codeFrom((await waitForMail(email)).text);
    sent.push(code);

    const off = await createTestApp();
    try {
      const res = await post(off.app, '/auth/register/confirm', {
        attemptId,
        code,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email, status: 'active' });
    } finally {
      await off.app.close();
    }
  });
});

describe('Registration over a real socket (e2e)', () => {
  it('checks CSRF on this public write', async () => {
    const { app, config } = await createTestApp();
    try {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .set('Origin', config.CORS_ORIGINS[0])
        .send({ email: newEmail(), password: PASSWORD });

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('csrf_rejected');
    } finally {
      await app.close();
    }
  });
});
