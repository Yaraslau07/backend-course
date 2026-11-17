import { createHmac, randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppConfig } from '@/core/config/config.types';

import {
  createUser,
  decodeJwt,
  ip,
  PASSWORD,
  send,
  setStatus,
} from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import { calls, RouteProbeModule } from './utils/route-probe.module';

/**
 * Spec 1.2 §1.3.4–1.3.6, through HTTP: refresh, logout, and the access check that every protected
 * route runs first. RBAC arrives in C10/C11, so a valid session still ends in 503 there for now.
 */

const sent: string[] = [PASSWORD];
const remember = (value: string) => {
  sent.push(value);
  return value;
};

/** A token signed like ours, with any claims: for expired, foreign-key and wrong-type cases. */
function sign(payload: Record<string, unknown>, base64urlSecret: string) {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${input}.${createHmac(
    'sha256',
    Buffer.from(base64urlSecret, 'base64url'),
  )
    .update(input)
    .digest('base64url')}`;
}

describe('Sessions (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      logs,
      imports: [RouteProbeModule],
    }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  async function signIn() {
    const user = await createUser(app);
    remember(user.email);
    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: PASSWORD },
    });
    expect(res.status).toBe(204);
    return {
      user,
      access: remember(res.cookies.get('access_token')!.value),
      refresh: remember(res.cookies.get('refresh_token')!.value),
    };
  }

  const claims = (
    sub: string,
    use: 'access' | 'refresh',
    iat: number,
    ttl: number,
  ) => ({
    sub,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
    iat,
    exp: iat + ttl,
    token_use: use,
  });

  describe('POST /auth/refresh', () => {
    it('gives a new pair for a valid refresh cookie: 204, no body', async () => {
      const { user, refresh } = await signIn();

      const res = await send(app, '/auth/refresh', {
        cookies: { refresh_token: refresh },
      });

      expect(res.status).toBe(204);
      expect(res.raw).toBe('');
      const access = res.cookies.get('access_token')!;
      const next = res.cookies.get('refresh_token')!;
      remember(access.value);
      remember(next.value);
      expect(decodeJwt(access.value).payload).toMatchObject({
        sub: user.id,
        token_use: 'access',
      });
      expect(decodeJwt(next.value).payload).toMatchObject({
        sub: user.id,
        token_use: 'refresh',
      });
      expect(access.attributes.get('max-age')).toBe('900');
      expect(next.attributes.get('path')).toBe('/auth/refresh');
      expect(next.attributes.get('max-age')).toBe('2592000');
    });

    it('does not revoke the used refresh token: it keeps working until its exp', async () => {
      const { refresh } = await signIn();

      const first = await send(app, '/auth/refresh', {
        cookies: { refresh_token: refresh },
      });
      const second = await send(app, '/auth/refresh', {
        cookies: { refresh_token: refresh },
      });

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      for (const res of [first, second]) {
        remember(res.cookies.get('access_token')!.value);
        remember(res.cookies.get('refresh_token')!.value);
      }
    });

    it('reads the refresh token from the cookie only: body, header and query are ignored', async () => {
      const { refresh } = await signIn();

      const inBody = await send(app, '/auth/refresh', {
        body: { refresh_token: refresh },
      });
      const inHeader = await send(app, '/auth/refresh', {
        headers: { authorization: `Bearer ${refresh}` },
      });
      const inQuery = await send(app, `/auth/refresh?refresh_token=${refresh}`);

      for (const res of [inBody, inHeader, inQuery]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_session');
        expect(res.cookies.size).toBe(0);
      }
    });

    it.each(['pending', 'blocked', 'deleting', 'deleted'])(
      'refuses a %s user with 401 invalid_session and no cookies',
      async (status) => {
        const { user, refresh } = await signIn();
        await setStatus(app, user.id, status);

        const res = await send(app, '/auth/refresh', {
          cookies: { refresh_token: refresh },
        });

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_session');
        expect(res.cookies.size).toBe(0);
      },
    );

    it('answers every kind of bad token with the same 401 invalid_session', async () => {
      const { user, access } = await signIn();
      const now = Math.floor(Date.now() / 1000);
      const tokens = [
        undefined,
        'garbage',
        // An access token in the refresh cookie (different key, different token_use).
        access,
        // A refresh token signed with the access key: right key for its kind is required.
        sign(claims(user.id, 'refresh', now, 3600), config.JWT_ACCESS_SECRET),
        // Expired more than 30 s ago.
        sign(
          claims(user.id, 'refresh', now - 3600, 60),
          config.JWT_REFRESH_SECRET,
        ),
        // A user that doesn't exist.
        sign(
          claims(randomUUID(), 'refresh', now, 3600),
          config.JWT_REFRESH_SECRET,
        ),
        // Another audience.
        sign(
          { ...claims(user.id, 'refresh', now, 3600), aud: 'someone-else' },
          config.JWT_REFRESH_SECRET,
        ),
      ];

      const bodies = new Set<string>();
      for (const token of tokens) {
        const res = await send(app, '/auth/refresh', {
          cookies: token === undefined ? undefined : { refresh_token: token },
        });
        expect(res.status).toBe(401);
        expect(res.cookies.size).toBe(0);
        const rest = { ...res.body };
        delete rest.requestId;
        bodies.add(JSON.stringify(rest));
      }
      expect([...bodies]).toEqual([
        JSON.stringify({
          statusCode: 401,
          code: 'invalid_session',
          message: 'The session is missing or invalid.',
        }),
      ]);
    });

    it('accepts a refresh token that expired less than 30 s ago (clock tolerance)', async () => {
      const { user } = await signIn();
      const now = Math.floor(Date.now() / 1000);
      const token = sign(
        claims(user.id, 'refresh', now - 100, 85),
        config.JWT_REFRESH_SECRET,
      );

      const res = await send(app, '/auth/refresh', {
        cookies: { refresh_token: token },
      });

      expect(res.status).toBe(204);
      remember(res.cookies.get('access_token')!.value);
      remember(res.cookies.get('refresh_token')!.value);
    });

    it('allows 30 refreshes per IP per minute; the 31st is 429', async () => {
      const from = ip();
      for (let i = 0; i < 30; i++) {
        expect(
          (await send(app, '/auth/refresh', { remoteAddress: from })).status,
        ).toBe(401);
      }
      const res = await send(app, '/auth/refresh', { remoteAddress: from });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('too_many_requests');
    });

    it('refuses a cross-origin refresh without the CSRF header', async () => {
      const { refresh } = await signIn();

      const res = await send(app, '/auth/refresh', {
        cookies: { refresh_token: refresh },
        headers: { origin: config.CORS_ORIGINS[0] },
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('csrf_rejected');
      expect(res.cookies.size).toBe(0);
    });
  });

  describe('POST /auth/logout', () => {
    function expectCleared(res: Awaited<ReturnType<typeof send>>) {
      expect(res.status).toBe(204);
      expect(res.raw).toBe('');
      const access = res.cookies.get('access_token')!;
      const refresh = res.cookies.get('refresh_token')!;
      expect(access.value).toBe('');
      expect(refresh.value).toBe('');
      expect(access.attributes.get('path')).toBe('/');
      expect(refresh.attributes.get('path')).toBe('/auth/refresh');
      for (const cookie of [access, refresh]) {
        expect(cookie.attributes.get('max-age')).toBe('0');
        expect(cookie.attributes.has('httponly')).toBe(true);
        expect(cookie.attributes.get('samesite')).toBe('Strict');
        expect(cookie.attributes.has('domain')).toBe(false);
      }
    }

    it('clears both cookies for a signed-in client', async () => {
      const { access, refresh } = await signIn();

      expectCleared(
        await send(app, '/auth/logout', {
          cookies: { access_token: access, refresh_token: refresh },
        }),
      );
    });

    it('clears both cookies without any cookie, and with invalid ones', async () => {
      expectCleared(await send(app, '/auth/logout'));
      expectCleared(
        await send(app, '/auth/logout', {
          cookies: { access_token: 'junk', refresh_token: 'junk' },
        }),
      );
    });

    it('refuses an untrusted origin with 403 csrf_rejected', async () => {
      const res = await send(app, '/auth/logout', {
        headers: { origin: 'https://evil.example' },
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('csrf_rejected');
    });

    it('accepts a trusted origin with X-CSRF-Protection: 1', async () => {
      expectCleared(
        await send(app, '/auth/logout', {
          headers: { origin: config.CORS_ORIGINS[0], 'x-csrf-protection': '1' },
        }),
      );
    });
  });

  describe('the access check on protected routes (spec 1.2 §1.3.6)', () => {
    const hit = (cookies?: Record<string, string>) =>
      send(app, '/__routes/protected', { method: 'GET', cookies });

    it('answers no cookie, a bad cookie and a refresh token with 401 invalid_session, without running the route', async () => {
      const { refresh } = await signIn();
      const before = calls.protected ?? 0;

      for (const cookies of [
        undefined,
        { access_token: 'garbage' },
        { access_token: refresh },
      ]) {
        const res = await hit(cookies);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_session');
      }
      expect(calls.protected ?? 0).toBe(before);
    });

    it('answers an expired access token with 401', async () => {
      const { user } = await signIn();
      const now = Math.floor(Date.now() / 1000);

      const res = await hit({
        access_token: sign(
          claims(user.id, 'access', now - 1000, 900),
          config.JWT_ACCESS_SECRET,
        ),
      });

      expect(res.status).toBe(401);
    });

    it.each(['pending', 'blocked', 'deleting', 'deleted'])(
      'answers a valid token of a %s user with 401',
      async (status) => {
        const { user, access } = await signIn();
        await setStatus(app, user.id, status);

        const res = await hit({ access_token: access });

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_session');
      },
    );

    it('lets an active user through authentication; the rest of the chain still fails closed (503 until C11)', async () => {
      const { access } = await signIn();
      const before = calls.protected ?? 0;

      const res = await hit({ access_token: access });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('authorization_unavailable');
      expect(calls.protected ?? 0).toBe(before);
    });

    it('logs the failure category, never the token', async () => {
      const { user, access } = await signIn();
      logs.clear();
      await hit();
      await hit({ access_token: 'garbage' });
      await hit({ access_token: `${access.slice(0, -2)}xx` });
      await setStatus(app, user.id, 'blocked');
      await hit({ access_token: access });

      const categories = logs
        .lines()
        .filter((line) => line.event === 'access_check')
        .map((line) => line.category);
      expect(categories).toEqual([
        'missing',
        'malformed',
        'signature',
        'user_inactive',
      ]);
    });
  });
});
