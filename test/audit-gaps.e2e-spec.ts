import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { AppException } from '@/core/errors/app.exception';
import { UserDataErasers } from '@/modules/erasure/user-data-erasers';
import { TokenService } from '@/modules/auth/tokens/token.service';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';

import { createUser, ip, PASSWORD, send } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import {
  type Actor,
  actorWithRoles,
  ensureBootstrapped,
  policyVersion,
} from './utils/rbac';

/**
 * Behaviour the assignment names that no other suite proves over HTTP (the independent audit of
 * the whole project): a database outage, the last `rbac@manage` holder, rejected admin requests in
 * the logs, case-variant ids, raster size limits, a repeated eraser, and the request id on
 * conversion logs.
 */

const logs = new LogCapture();
const sensitive: string[] = [PASSWORD];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let admin: Actor;

beforeAll(async () => {
  ({ app, config } = await createTestApp({
    logs,
    env: {
      LOGIN_EMAIL_CONFIRMATION_ENABLED: 'false',
      IMAGE_PNG_MAX_BYTES: '1000',
      IMAGE_JPEG_MAX_BYTES: '1000',
    },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  await app.get(RbacPermissionSeeds).applyAll();
  admin = await actorWithRoles(app, ['admin']);
});
beforeEach(() => resetRateLimits(app));
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
});

const json = (body: string) =>
  JSON.parse(body || '{}') as Record<string, unknown>;

function request(
  actor: Actor | undefined,
  method: 'GET' | 'PUT' | 'PATCH' | 'POST',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    cookies: actor?.cookies,
    ...(payload === undefined
      ? {}
      : { payload: payload as Record<string, unknown> }),
    remoteAddress: ip(),
  });
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; content: Buffer | string },
) {
  const boundary = `----audit${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields))
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    Buffer.from(file.content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('a database outage is 503, never 401 (spec 1.2 §1.3.4, 1.3 §1.3.1)', () => {
  /** Only the user lookup fails, as if the database dropped between the checks. */
  function breakUserLookup() {
    const original = db.query.bind(db) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return jest.spyOn(db, 'query').mockImplementation(((
      sql: string,
      ...rest: unknown[]
    ) =>
      /FROM users WHERE id = \$1/.test(sql)
        ? Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            }),
          )
        : original(sql, ...rest)) as never);
  }

  it('a protected route answers 503 authorization_unavailable and never runs the handler', async () => {
    const actor = await actorWithRoles(app, ['user']);
    expect(
      (await request(actor, 'GET', '/api/transformations/history')).statusCode,
    ).toBe(200);
    logs.clear();
    const lookup = breakUserLookup();
    const res = await request(actor, 'GET', '/api/transformations/history');
    lookup.mockRestore();

    expect(res.statusCode).toBe(503);
    expect(json(res.body).code).toBe('authorization_unavailable');
    expect(
      logs.lines().some((line) => line.event === 'transformation_history'),
    ).toBe(false);
    // And it recovers without a restart.
    expect(
      (await request(actor, 'GET', '/api/transformations/history')).statusCode,
    ).toBe(200);
  });

  it('refresh answers 503 with no Set-Cookie when the user lookup fails', async () => {
    const user = await createUser(app);
    const refresh = app.get(TokenService).issuePair(user.id).refresh;
    const lookup = breakUserLookup();
    const res = await send(app, '/auth/refresh', {
      cookies: { refresh_token: refresh },
    });
    lookup.mockRestore();

    expect(res.status).toBe(503);
    expect(res.headers['set-cookie']).toBeUndefined();
    sensitive.push(refresh);
  });

  it('login answers 503 and sets no cookie when the pair cannot be signed', async () => {
    const user = await createUser(app);
    jest.spyOn(app.get(TokenService), 'issuePair').mockImplementation(() => {
      throw new AppException('service_unavailable');
    });
    const res = await send(app, '/auth/login', {
      body: { email: user.email, password: user.password },
    });

    expect(res.status).toBe(503);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.raw).not.toContain(user.email);
  });
});

describe('the last active rbac@manage holder (spec 1.1 §1.1, 1.5 §1.3.1 step 9)', () => {
  /** Blocks every other active holder for the test; returns the undo. Suites run one at a time. */
  async function onlyManagers(keep: string[]): Promise<() => Promise<void>> {
    const holders = await db.query<{ id: string }[]>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN grants g ON g.role_id = ur.role_id
         JOIN permissions p ON p.id = g.permission_id AND p.name = 'rbac'
         JOIN permission_actions pa ON pa.permission_id = p.id AND pa.action = 'manage'
        WHERE u.status = 'active'
          AND (g.all_actions OR EXISTS (
                SELECT 1 FROM grant_actions ga WHERE ga.grant_id = g.id AND ga.action = 'manage'))`,
    );
    const others = holders.map((h) => h.id).filter((id) => !keep.includes(id));
    if (others.length > 0)
      await db.query(
        `UPDATE users SET status = 'blocked' WHERE id = ANY($1::uuid[])`,
        [others],
      );
    return async () => {
      if (others.length > 0)
        await db.query(
          `UPDATE users SET status = 'active' WHERE id = ANY($1::uuid[])`,
          [others],
        );
    };
  }

  it('PATCH status=blocked on the only holder is 409 last_rbac_manager and changes nothing', async () => {
    const sole = await actorWithRoles(app, ['admin']);
    const restore = await onlyManagers([sole.id]);
    try {
      const [before] = await db.query<{ status: string; updated_at: Date }[]>(
        `SELECT status, updated_at FROM users WHERE id = $1`,
        [sole.id],
      );
      const res = await request(sole, 'PATCH', `/users/${sole.id}`, {
        status: 'blocked',
      });

      expect(res.statusCode).toBe(409);
      expect(json(res.body).code).toBe('last_rbac_manager');
      const [after] = await db.query<{ status: string; updated_at: Date }[]>(
        `SELECT status, updated_at FROM users WHERE id = $1`,
        [sole.id],
      );
      expect(after).toEqual(before);
    } finally {
      await restore();
    }
  });

  it("replacing the only holder's roles with none is 409, the version unchanged", async () => {
    const sole = await actorWithRoles(app, ['admin']);
    const restore = await onlyManagers([sole.id]);
    try {
      const version = await policyVersion(db);
      const res = await request(
        sole,
        'PUT',
        `/admin/rbac/users/${sole.id}/roles`,
        { roleIds: [] },
      );

      expect(res.statusCode).toBe(409);
      expect(json(res.body).code).toBe('last_rbac_manager');
      expect(await policyVersion(db)).toBe(version);
      const [{ count }] = await db.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM user_roles WHERE user_id = $1`,
        [sole.id],
      );
      expect(count).toBe(1);
    } finally {
      await restore();
    }
  });

  it('two holders removing each other at once: exactly one succeeds, one holder remains', async () => {
    const a = await actorWithRoles(app, ['admin']);
    const b = await actorWithRoles(app, ['admin']);
    const restore = await onlyManagers([a.id, b.id]);
    try {
      const [first, second] = await Promise.all([
        request(a, 'PUT', `/admin/rbac/users/${b.id}/roles`, { roleIds: [] }),
        request(b, 'PUT', `/admin/rbac/users/${a.id}/roles`, { roleIds: [] }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const [{ count }] = await db.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM user_roles WHERE user_id = ANY($1::uuid[])`,
        [[a.id, b.id]],
      );
      expect(count).toBe(1);
    } finally {
      await restore();
    }
  });
});

describe('rejected administrative requests are logged (spec 1.1 §1.5)', () => {
  it('a 400 from validation is logged with actor, operation, entity, version and result, never the body', async () => {
    logs.clear();
    const res = await request(admin, 'PUT', '/admin/rbac/roles/not-a-uuid', {
      name: 'x',
      description: 'SECRET-DESCRIPTION',
    });
    expect(res.statusCode).toBe(400);

    const line = logs
      .lines()
      .find((l) => l.event === 'rbac_change' && l.result === 'failure');
    expect(line).toMatchObject({
      actorUserId: admin.id,
      operation: 'replaceRole',
      entityType: 'role',
      result: 'failure',
      errorCode: 'bad_request',
    });
    expect(typeof line?.version).toBe('string');
    expect(logs.text()).not.toContain('SECRET-DESCRIPTION');
  });

  it('a refusal the service already logged is logged once', async () => {
    logs.clear();
    const res = await request(
      admin,
      'PUT',
      `/admin/rbac/roles/${randomUUID()}`,
      {
        name: `absent-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(res.statusCode).toBe(404);
    const failures = logs
      .lines()
      .filter((l) => l.event === 'rbac_change' && l.result === 'failure');
    expect(failures).toHaveLength(1);
  });

  it('role ids that differ only in letter case are a repeat: 400, not a missing role', async () => {
    const target = await actorWithRoles(app, ['user']);
    const [role] = await db.query<{ id: string }[]>(
      `SELECT id FROM roles WHERE name = 'user'`,
    );
    const res = await request(
      admin,
      'PUT',
      `/admin/rbac/users/${target.id}/roles`,
      { roleIds: [role.id, role.id.toUpperCase()] },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('raster input limits (spec 2.2 §1.1)', () => {
  it.each([
    ['png', 'image/png', 'jpeg'],
    ['jpg', 'image/jpeg', 'png'],
  ])(
    'a .%s over its limit is 413 and writes no history',
    async (ext, mime, target) => {
      const member = await actorWithRoles(app, ['user']);
      const body = multipart(
        { targetFormat: target },
        { name: `big.${ext}`, type: mime, content: Buffer.alloc(2000, 1) },
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/images/convert',
        cookies: member.cookies,
        payload: body.payload,
        headers: body.headers,
        remoteAddress: ip(),
      });

      expect(res.statusCode).toBe(413);
      expect(json(res.body).code).toBe('payload_too_large');
      const [{ count }] = await db.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM transformations WHERE user_id = $1`,
        [member.id],
      );
      expect(count).toBe(0);
    },
  );
});

describe('user data erasure repeats safely (spec 1.6 §1.3.5)', () => {
  it('running every eraser twice succeeds both times and leaves nothing behind', async () => {
    const victim = await actorWithRoles(app, ['user']);
    await db.query(
      `INSERT INTO transformations
         (user_id, type, source_format, target_format, status, input_size, output_size, duration_ms)
       VALUES ($1, 'file', 'csv', 'json', 'success', 1, 2, 3)`,
      [victim.id],
    );
    const erasers = app.get(UserDataErasers);

    expect(await erasers.eraseAll(victim.id, '0'.repeat(32))).toEqual({
      result: 'succeeded',
    });
    expect(await erasers.eraseAll(victim.id, '0'.repeat(32))).toEqual({
      result: 'succeeded',
    });
    const [{ count }] = await db.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM transformations WHERE user_id = $1`,
      [victim.id],
    );
    expect(count).toBe(0);
  });
});

describe('conversion logs carry the request id (spec 2.0 §1.5)', () => {
  it('the transformation event is logged under the same id as the response header', async () => {
    const member = await actorWithRoles(app, ['user']);
    logs.clear();
    const body = multipart(
      { targetFormat: 'json' },
      { name: 'people.csv', type: 'text/csv', content: 'name\nAda\n' },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert',
      cookies: member.cookies,
      payload: body.payload,
      headers: body.headers,
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(200);

    const line = logs.lines().find((l) => l.event === 'transformation');
    expect((line?.req as { id: string }).id).toBe(res.headers['x-request-id']);
  });
});
