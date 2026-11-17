import { createHmac, randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import { AppConfig } from '@/core/config/config.types';
import { TokenService } from '@/modules/auth/tokens/token.service';

import { createUser, setStatus } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import {
  type Actor,
  actorWithRoles,
  bumpPolicy,
  ensureBootstrapped,
  probeRole,
} from './utils/rbac';
import { calls, RouteProbeModule } from './utils/route-probe.module';

/**
 * Spec 1.3 through HTTP: the whole chain in its order (access → active user → CSRF → limits →
 * RBAC → resource → ownership → handler), every reason for 401, the three 403s, blocking and role
 * changes taking effect without a new JWT, and what a public route ignores. 503 for an unreadable
 * user or policy is covered with failing fakes in the unit tests and in rbac.e2e-spec.ts.
 */

const logs = new LogCapture();
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;

beforeAll(async () => {
  ({ app, config } = await createTestApp({
    logs,
    imports: [RouteProbeModule],
  }));
  db = app.get(DataSource);
  await resetRateLimits(app);
  await ensureBootstrapped(app);
});

afterAll(async () => {
  logs.expectNoLeaks(config);
  await app.close();
});

async function call(
  method: 'GET' | 'POST' | 'OPTIONS',
  url: string,
  options: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const res = await app.inject({
    method,
    url,
    cookies: options.cookies,
    headers: options.headers,
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body || '{}') as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, headers: res.headers };
}

const bodyWithoutId = (body: Record<string, unknown>) => {
  const rest = { ...body };
  delete rest.requestId;
  return rest;
};

/** Signed like ours with any claims, for the token cases a real login can't produce. */
function forge(payload: Record<string, unknown>, base64urlSecret: string) {
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

const claims = (sub: string, overrides: Record<string, unknown> = {}) => {
  const iat = Math.floor(Date.now() / 1000);
  return {
    sub,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
    iat,
    exp: iat + 900,
    token_use: 'access',
    ...overrides,
  };
};

const reader = async () =>
  actorWithRoles(app, [await probeRole(app, ['read'])]);

describe('the order of the chain (spec 1.3 §1.3.1, §1.6)', () => {
  it('access before CSRF: a cross-origin write without a session is 401, not 403', async () => {
    const res = await call('POST', '/__routes/protected', {
      headers: { origin: 'https://evil.example' },
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_session');
  });

  it('CSRF before RBAC: a signed-in user without the right is refused as csrf_rejected', async () => {
    const actor = await actorWithRoles(app, []);

    const res = await call('POST', '/__routes/protected', {
      cookies: actor.cookies,
      headers: { origin: 'https://evil.example' },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_rejected');
  });

  it('RBAC before the resource: without the right, an unknown id is 403, never 404, and nothing is looked up', async () => {
    const actor = await actorWithRoles(app, []);
    const before = calls['owned-lookup'] ?? 0;

    const res = await call('GET', `/__routes/owned/${randomUUID()}`, {
      cookies: actor.cookies,
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(calls['owned-lookup'] ?? 0).toBe(before);
  });

  it('the handler runs only when every step allows it', async () => {
    const actor = await reader();
    const before = calls.protected ?? 0;

    const res = await call('GET', '/__routes/protected', {
      cookies: actor.cookies,
    });

    expect(res.status).toBe(200);
    expect(calls.protected).toBe(before + 1);
  });
});

describe('401 invalid_session for every identity failure (spec 1.3 §1.4)', () => {
  let actor: Actor;

  beforeAll(async () => {
    actor = await reader();
  });

  it('answers every token and user failure with the same 401 body, and logs each category', async () => {
    const other = randomUUID();
    const cases: [string, Record<string, string> | undefined][] = [
      ['missing', undefined],
      ['malformed', { access_token: 'not.a.jwt!' }],
      [
        'signature',
        { access_token: forge(claims(actor.id), config.JWT_REFRESH_SECRET) },
      ],
      [
        'expired',
        {
          access_token: forge(
            claims(actor.id, { iat: 1_700_000_000, exp: 1_700_000_900 }),
            config.JWT_ACCESS_SECRET,
          ),
        },
      ],
      [
        'claims',
        {
          access_token: forge(
            claims(actor.id, { aud: 'someone-else' }),
            config.JWT_ACCESS_SECRET,
          ),
        },
      ],
      [
        'token_use',
        {
          access_token: forge(
            claims(actor.id, { token_use: 'refresh' }),
            config.JWT_ACCESS_SECRET,
          ),
        },
      ],
      [
        'user_inactive',
        { access_token: forge(claims(other), config.JWT_ACCESS_SECRET) },
      ],
    ];
    logs.clear();

    const bodies = new Set<string>();
    for (const [, cookies] of cases) {
      const res = await call('GET', '/__routes/protected', { cookies });
      expect(res.status).toBe(401);
      bodies.add(JSON.stringify(bodyWithoutId(res.body)));
    }

    expect([...bodies]).toEqual([
      JSON.stringify({
        statusCode: 401,
        code: 'invalid_session',
        message: 'The session is missing or invalid.',
      }),
    ]);
    const logged = logs
      .lines()
      .filter((line) => line.event === 'access_check')
      .map((line) => line.category);
    expect(logged).toEqual(cases.map(([category]) => category));
  });

  it.each(['pending', 'blocked', 'deleting', 'deleted'])(
    'answers a valid token of a %s user with 401',
    async (status) => {
      const user = await reader();
      await setStatus(app, user.id, status);

      const res = await call('GET', '/__routes/protected', {
        cookies: user.cookies,
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_session');
    },
  );

  it('takes a block into account on the very next request, with the same token', async () => {
    const user = await reader();
    expect(
      (await call('GET', '/__routes/protected', { cookies: user.cookies }))
        .status,
    ).toBe(200);

    await setStatus(app, user.id, 'blocked');

    expect(
      (await call('GET', '/__routes/protected', { cookies: user.cookies }))
        .status,
    ).toBe(401);
  });

  it('accepts the access token from the cookie only', async () => {
    const token = app.get(TokenService).issuePair(actor.id).access;

    const header = await call('GET', '/__routes/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    const query = await call(
      'GET',
      `/__routes/protected?access_token=${token}`,
    );

    expect(header.status).toBe(401);
    expect(query.status).toBe(401);
  });
});

describe('403s and what they reveal (spec 1.3 §1.3.1, §1.5)', () => {
  it('permission_denied carries no roles, permission, status or version', async () => {
    const actor = await actorWithRoles(app, ['user']);

    const res = await call('GET', '/__routes/protected', {
      cookies: actor.cookies,
    });

    expect(res.status).toBe(403);
    expect(bodyWithoutId(res.body)).toEqual({
      statusCode: 403,
      code: 'permission_denied',
      message: 'You do not have permission for this operation.',
    });
  });

  it('a role change applies to the next request without a new token', async () => {
    const actor = await actorWithRoles(app, []);
    expect(
      (await call('GET', '/__routes/protected', { cookies: actor.cookies }))
        .status,
    ).toBe(403);

    const [role] = await db.query<{ id: string }[]>(
      `SELECT id FROM roles WHERE name = $1`,
      [await probeRole(app, ['read'])],
    );
    await db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [actor.id, role.id],
    );
    await bumpPolicy(db);

    expect(
      (await call('GET', '/__routes/protected', { cookies: actor.cookies }))
        .status,
    ).toBe(200);
  });

  it('logs the RBAC decision with the actor, operation, pair, version and result', async () => {
    const allowed = await reader();
    const denied = await actorWithRoles(app, []);
    logs.clear();

    await call('GET', '/__routes/protected', { cookies: allowed.cookies });
    await call('GET', '/__routes/protected', { cookies: denied.cookies });

    const decisions = logs
      .lines()
      .filter((line) => line.event === 'rbac_decision');
    expect(decisions).toEqual([
      expect.objectContaining({
        result: 'allowed',
        actorUserId: allowed.id,
        operation: 'RouteProbeController.protectedRoute',
        permission: 'probe',
        action: 'read',
        version: expect.any(String) as string,
      }),
      expect.objectContaining({
        result: 'denied',
        category: 'permission_denied',
        actorUserId: denied.id,
      }),
    ]);
  });
});

describe('the resource and ownership step (spec 1.3 §1.3.4)', () => {
  it('lets the owner act on their own id', async () => {
    const actor = await reader();

    const res = await call('GET', `/__routes/owned/${actor.id}`, {
      cookies: actor.cookies,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: 'self' });
  });

  it('refuses someone else’s id without the _any action: 403 ownership_denied, before any lookup', async () => {
    const actor = await reader();
    const other = await createUser(app);
    const before = calls['owned-lookup'] ?? 0;
    logs.clear();

    const existing = await call('GET', `/__routes/owned/${other.id}`, {
      cookies: actor.cookies,
    });
    const unknown = await call('GET', `/__routes/owned/${randomUUID()}`, {
      cookies: actor.cookies,
    });

    expect(existing.status).toBe(403);
    expect(existing.body.code).toBe('ownership_denied');
    // Same answer whether the target exists or not.
    expect(bodyWithoutId(unknown.body)).toEqual(bodyWithoutId(existing.body));
    expect(calls['owned-lookup'] ?? 0).toBe(before);
    expect(logs.lines()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'ownership',
          category: 'ownership_denied',
        }),
      ]),
    );
    expect(logs.text()).not.toContain(other.id);
  });

  it('with the _any action: someone else’s id is allowed, and an unknown one is 404', async () => {
    const actor = await actorWithRoles(app, [
      await probeRole(app, ['read', 'read_any']),
    ]);
    const other = await createUser(app);

    const existing = await call('GET', `/__routes/owned/${other.id}`, {
      cookies: actor.cookies,
    });
    const unknown = await call('GET', `/__routes/owned/${randomUUID()}`, {
      cookies: actor.cookies,
    });

    expect(existing.status).toBe(200);
    expect(existing.body).toEqual({ scope: 'foreign' });
    expect(unknown.status).toBe(404);
  });
});

describe('user-keyed rate limits on protected routes (spec 1.3, D46)', () => {
  it('counts per verified user: the 61st request in a minute is 429, another user is unaffected', async () => {
    const actor = await reader();
    const other = await reader();

    for (let i = 0; i < 60; i++) {
      const res = await call('GET', '/__routes/user-limited', {
        cookies: actor.cookies,
      });
      expect(res.status).toBe(200);
    }
    const limited = await call('GET', '/__routes/user-limited', {
      cookies: actor.cookies,
    });
    const fresh = await call('GET', '/__routes/user-limited', {
      cookies: other.cookies,
    });

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('too_many_requests');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(fresh.status).toBe(200);
  });

  it('does not count a request that had no session', async () => {
    const actor = await reader();
    for (let i = 0; i < 5; i++) {
      expect((await call('GET', '/__routes/user-limited')).status).toBe(401);
    }

    expect(
      (await call('GET', '/__routes/user-limited', { cookies: actor.cookies }))
        .status,
    ).toBe(200);
  });
});

describe('the request log (spec 1.3 §1.5)', () => {
  it('names the matched route pattern, never the concrete path with the target id', async () => {
    const actor = await reader();
    const target = randomUUID();
    logs.clear();

    await call('GET', `/__routes/owned/${target}`, { cookies: actor.cookies });

    const completed = logs
      .lines()
      .filter((line) => line.msg === 'request completed');
    expect(completed).toEqual([
      expect.objectContaining({ route: '/__routes/owned/:userId' }),
    ]);
    expect(logs.text()).not.toContain(target);
  });
});

describe('public routes and preflight (spec 1.3 §1.3.2, §1.3.5)', () => {
  it('ignores an invalid cookie on a public route', async () => {
    const live = await call('GET', '/health/live', {
      cookies: { access_token: 'garbage' },
    });
    const logout = await call('POST', '/auth/logout', {
      cookies: { access_token: 'garbage' },
    });

    expect(live.status).toBe(200);
    expect(logout.status).toBe(204);
  });

  it('answers a CORS preflight for a protected route without a cookie, for an allowed origin only', async () => {
    const allowed = await call('OPTIONS', '/__routes/protected', {
      headers: {
        origin: config.CORS_ORIGINS[0],
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-csrf-protection,content-type',
      },
    });
    const refused = await call('OPTIONS', '/__routes/protected', {
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      config.CORS_ORIGINS[0],
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });
});
