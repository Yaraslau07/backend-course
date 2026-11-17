import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { AccessAuthenticator } from './access-authenticator';
import { AuthCookies } from './auth-cookies';
import { LoginController } from './login.controller';
import type { LoginService } from './login.service';
import { SessionService } from './session.service';
import * as jwt from './tokens/jwt';
import { TokenService } from './tokens/token.service';

/**
 * Tokens, cookies, the access check and refresh with the database scripted. The real flows are in
 * test/session.e2e-spec.ts.
 */
const USER = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const values: Record<string, unknown> = {
  JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('base64url'),
  JWT_ISSUER: 'issuer',
  JWT_AUDIENCE: 'audience',
  COOKIE_SECURE: true,
  COOKIE_SAME_SITE: 'strict',
};
const config = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) => ({ ...values, ...overrides })[key],
  }) as unknown as ConfigService;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return 'resolved';
}

function fakeReply() {
  const setCookie = jest.fn<
    unknown,
    [string, string, Record<string, unknown>]
  >();
  const reply = { setCookie, status: jest.fn() };
  setCookie.mockReturnValue(reply);
  reply.status.mockReturnValue(reply);
  return {
    reply: reply as unknown as FastifyReply,
    setCookie,
    status: reply.status,
  };
}

const requestWith = (cookies?: Record<string, string>) =>
  ({ cookies, ip: '203.0.113.1' }) as unknown as FastifyRequest;

function dbReturning(rows: unknown[] | Error) {
  const query = jest.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  return { db: { query } as unknown as DataSource, query };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});

afterEach(() => jest.restoreAllMocks());

describe('TokenService', () => {
  const tokens = new TokenService(config());

  it('signs a pair that verifies only as its own kind', () => {
    const pair = tokens.issuePair(USER);

    expect(tokens.verify('access', pair.access)).toMatchObject({
      ok: true,
      claims: { sub: USER, token_use: 'access' },
    });
    expect(tokens.verify('refresh', pair.refresh)).toMatchObject({
      ok: true,
      claims: { sub: USER, token_use: 'refresh' },
    });
    // Different keys: the other kind fails on its signature already.
    expect(tokens.verify('access', pair.refresh)).toEqual({
      ok: false,
      failure: 'signature',
    });
  });

  it('answers a signing failure with 503 service_unavailable', () => {
    jest.spyOn(jwt, 'signJwt').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => tokens.issuePair(USER)).toThrow(AppException);
    try {
      tokens.issuePair(USER);
    } catch (error) {
      expect((error as AppException).code).toBe('service_unavailable');
    }
  });
});

describe('AuthCookies', () => {
  it('sets both cookies with the spec attributes', () => {
    const { reply, setCookie } = fakeReply();

    new AuthCookies(config()).set(reply, { access: 'A', refresh: 'R' });

    expect(setCookie.mock.calls).toEqual([
      [
        'access_token',
        'A',
        {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/',
          maxAge: 900,
        },
      ],
      [
        'refresh_token',
        'R',
        {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/auth/refresh',
          maxAge: 2_592_000,
        },
      ],
    ]);
  });

  it('uses SameSite=None when configured for a cross-site frontend', () => {
    const { reply, setCookie } = fakeReply();

    new AuthCookies(config({ COOKIE_SAME_SITE: 'none' })).set(reply, {
      access: 'A',
      refresh: 'R',
    });

    for (const call of setCookie.mock.calls) {
      expect(call[2]).toMatchObject({ sameSite: 'none', secure: true });
    }
  });

  it('clears both cookies with the same paths and attributes', () => {
    const { reply, setCookie } = fakeReply();

    new AuthCookies(config()).clear(reply);

    expect(
      setCookie.mock.calls.map(([name, value, options]) => [
        name,
        value,
        options,
      ]),
    ).toEqual([
      [
        'access_token',
        '',
        expect.objectContaining({ path: '/', maxAge: 0, httpOnly: true }),
      ],
      [
        'refresh_token',
        '',
        expect.objectContaining({
          path: '/auth/refresh',
          maxAge: 0,
          httpOnly: true,
        }),
      ],
    ]);
  });

  it('reads a cookie, treating an empty or missing one as absent', () => {
    const cookies = new AuthCookies(config());

    expect(
      cookies.read(requestWith({ access_token: 'x' }), 'access_token'),
    ).toBe('x');
    expect(
      cookies.read(requestWith({ access_token: '' }), 'access_token'),
    ).toBeUndefined();
    expect(cookies.read(requestWith(), 'refresh_token')).toBeUndefined();
  });
});

describe('AccessAuthenticator', () => {
  const tokens = new TokenService(config());
  const cookies = new AuthCookies(config());
  const access = () => tokens.issuePair(USER).access;

  it('gives the user id of an active user and records it on the request', async () => {
    const request = requestWith({ access_token: access() });

    expect(
      await new AccessAuthenticator(
        dbReturning([{ status: 'active' }]).db,
        tokens,
        cookies,
      ).authenticate(request),
    ).toBe(USER);
    expect(request.authUserId).toBe(USER);
  });

  it.each<[string, unknown[]]>([
    ['an absent user', []],
    ['a blocked user', [{ status: 'blocked' }]],
  ])('answers %s with 401 invalid_session', async (_name, rows) => {
    const auth = new AccessAuthenticator(dbReturning(rows).db, tokens, cookies);

    expect(
      await codeOf(() =>
        auth.authenticate(requestWith({ access_token: access() })),
      ),
    ).toBe('invalid_session');
  });

  it('answers a bad token with 401 without touching the database', async () => {
    const { db, query } = dbReturning([{ status: 'active' }]);
    const auth = new AccessAuthenticator(db, tokens, cookies);

    expect(await codeOf(() => auth.authenticate(requestWith()))).toBe(
      'invalid_session',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('answers an unreadable user with 503 authorization_unavailable, never 401', async () => {
    const down = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
    });
    const auth = new AccessAuthenticator(dbReturning(down).db, tokens, cookies);

    expect(
      await codeOf(() =>
        auth.authenticate(requestWith({ access_token: access() })),
      ),
    ).toBe('authorization_unavailable');
  });

  it('lets an error that is not an outage through to the filter (a 500, not a 503)', async () => {
    const bug = new TypeError('boom');
    const auth = new AccessAuthenticator(dbReturning(bug).db, tokens, cookies);

    await expect(
      auth.authenticate(requestWith({ access_token: access() })),
    ).rejects.toBe(bug);
  });
});

describe('SessionService', () => {
  const tokens = new TokenService(config());
  const refresh = () => tokens.issuePair(USER).refresh;

  it('signs a new pair for an active user', async () => {
    const pair = await new SessionService(
      dbReturning([{ status: 'active' }]).db,
      tokens,
    ).refresh(refresh());

    expect(tokens.verify('access', pair.access).ok).toBe(true);
    expect(tokens.verify('refresh', pair.refresh).ok).toBe(true);
  });

  it.each<[string, string | undefined, unknown[]]>([
    ['no token', undefined, [{ status: 'active' }]],
    ['an access token', 'access', [{ status: 'active' }]],
    ['a deleting user', 'refresh', [{ status: 'deleting' }]],
    ['an absent user', 'refresh', []],
  ])('answers %s with 401 invalid_session', async (_name, kind, rows) => {
    const pair = tokens.issuePair(USER);
    const token =
      kind === undefined
        ? undefined
        : kind === 'access'
          ? pair.access
          : pair.refresh;

    expect(
      await codeOf(() =>
        new SessionService(dbReturning(rows).db, tokens).refresh(token),
      ),
    ).toBe('invalid_session');
  });

  it('lets a database failure through for the error filter (503, not 401)', async () => {
    const failure = new Error('ECONNREFUSED');

    await expect(
      new SessionService(dbReturning(failure).db, tokens).refresh(refresh()),
    ).rejects.toBe(failure);
  });
});

describe('LoginController', () => {
  const pair = { access: 'A', refresh: 'R' };

  function controller(result: Awaited<ReturnType<LoginService['login']>>) {
    const login = {
      login: jest.fn().mockResolvedValue(result),
      confirm: jest.fn().mockResolvedValue(pair),
      resend: jest.fn().mockResolvedValue({ method: 'otp' }),
    } as unknown as LoginService;
    const refresh = jest.fn().mockResolvedValue(pair);
    const sessions = {
      refresh,
      logout: jest.fn(),
    } as unknown as SessionService;
    const cookies = {
      set: jest.fn<void, [FastifyReply, unknown]>(),
      clear: jest.fn<void, [FastifyReply]>(),
      read: jest.fn().mockReturnValue('R'),
    };
    return {
      controller: new LoginController(
        login,
        sessions,
        cookies as unknown as AuthCookies,
      ),
      cookies,
      refresh,
    };
  }

  it('sets cookies and answers 204 for a direct login', async () => {
    const { controller: c, cookies } = controller({ kind: 'session', pair });
    const { reply, status } = fakeReply();

    expect(
      await c.signIn(
        { email: 'a@example.com', password: 'p' },
        requestWith(),
        reply,
      ),
    ).toBeUndefined();
    expect(cookies.set).toHaveBeenCalledWith(reply, pair);
    expect(status).toHaveBeenCalledWith(204);
  });

  it('answers 202 with the body and no cookies when confirmation is needed', async () => {
    const { controller: c, cookies } = controller({
      kind: 'challenge',
      body: { method: 'otp' },
    });
    const { reply, status } = fakeReply();

    expect(
      await c.signIn(
        { email: 'a@example.com', password: 'p' },
        requestWith(),
        reply,
      ),
    ).toEqual({ method: 'otp' });
    expect(status).toHaveBeenCalledWith(202);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('sets cookies after confirm and refresh, and clears them on logout', async () => {
    const {
      controller: c,
      cookies,
      refresh,
    } = controller({ kind: 'session', pair });
    const { reply } = fakeReply();

    await c.confirm({ attemptId: 'x', code: '123456' }, reply);
    await c.refresh(requestWith(), reply);
    c.logout(reply);
    expect(await c.resend({ attemptId: 'x' })).toEqual({ method: 'otp' });

    expect(cookies.set).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith('R');
    expect(cookies.clear).toHaveBeenCalledWith(reply);
  });
});
