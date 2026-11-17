import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppConfig } from '@/core/config/config.types';
import { RbacBootstrap } from '@/modules/rbac/rbac-bootstrap';

import { createUser, PASSWORD, send } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { waitForMail } from './utils/mailpit';
import { resetRateLimits } from './utils/rate-limits';
import {
  type Actor,
  actorWithRoles,
  bumpPolicy,
  ensureBootstrapped,
  policyVersion,
  roleId,
  uniqueName,
  wipeRbac,
} from './utils/rbac';
import { calls, RouteProbeModule } from './utils/route-probe.module';

/**
 * Spec 1.1 through HTTP: the bootstrap, the access check on protected routes (allow, deny, role
 * merging, all and listed actions, dynamic updates, an unavailable snapshot), the admin API and
 * the default role on activation. app_test is shared, so names are unique per run and no test
 * assumes it holds the only admin, except where the change affects every admin at once.
 */

const sent: string[] = [PASSWORD];
/** One capture for the file: nestjs-pino keeps the first app's logger (see CLAUDE.md). */
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
});

afterAll(async () => {
  logs.expectNoLeaks(config, sent);
  await app.close();
});

async function call(
  actor: Actor | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await app.inject({
    method,
    url,
    cookies: actor?.cookies,
    headers,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  let json: unknown = undefined;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: res.statusCode,
    body: json as Record<string, unknown>,
    raw: res.body,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

describe('Bootstrap (spec 1.1 §1.1)', () => {
  beforeAll(async () => {
    await wipeRbac(db);
  });

  afterAll(async () => {
    await ensureBootstrapped(app);
  });

  it('does nothing without a configured admin, so it can run at the next start', async () => {
    expect(await app.get(RbacBootstrap).run(undefined)).toBe(
      'no_admin_configured',
    );
    const [{ count }] = await db.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM roles`,
    );
    expect(count).toBe(0);
  });

  it.each(['pending', 'blocked'])(
    'does nothing when the admin user is %s',
    async (status) => {
      const user = await createUser(app, { status });

      expect(await app.get(RbacBootstrap).run(user.id)).toBe(
        'admin_not_active',
      );
      const [{ count }] = await db.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM permissions`,
      );
      expect(count).toBe(0);
    },
  );

  it('does nothing for an admin id that does not exist', async () => {
    expect(await app.get(RbacBootstrap).run(randomUUID())).toBe(
      'admin_not_active',
    );
  });

  it('creates the permissions, the two roles and their grants, and assigns the roles', async () => {
    const admin = await createUser(app);
    const roleless = await createUser(app);
    const pending = await createUser(app, { status: 'pending' });
    const before = await policyVersion(db);

    expect(await app.get(RbacBootstrap).run(admin.id)).toBe('bootstrapped');

    const permissions = await db.query<{ name: string; actions: string[] }[]>(
      `SELECT p.name, array_agg(pa.action ORDER BY pa.action) AS actions
         FROM permissions p JOIN permission_actions pa ON pa.permission_id = p.id
        GROUP BY p.name ORDER BY p.name`,
    );
    expect(permissions).toEqual([
      { name: 'rbac', actions: ['manage'] },
      {
        name: 'users',
        actions: [
          'delete',
          'delete_any',
          'list',
          'read',
          'read_any',
          'update',
          'update_any',
        ].sort(),
      },
    ]);

    const grants = await db.query<
      {
        role: string;
        permission: string;
        all_actions: boolean;
        actions: string[];
      }[]
    >(
      `SELECT r.name AS role, p.name AS permission, g.all_actions,
              coalesce(array_agg(ga.action ORDER BY ga.action) FILTER (WHERE ga.action IS NOT NULL), '{}') AS actions
         FROM grants g JOIN roles r ON r.id = g.role_id JOIN permissions p ON p.id = g.permission_id
         LEFT JOIN grant_actions ga ON ga.grant_id = g.id
        GROUP BY r.name, p.name, g.all_actions ORDER BY r.name, p.name`,
    );
    expect(grants).toEqual([
      {
        role: 'admin',
        permission: 'rbac',
        all_actions: false,
        actions: ['manage'],
      },
      { role: 'admin', permission: 'users', all_actions: true, actions: [] },
      {
        role: 'user',
        permission: 'users',
        all_actions: false,
        actions: ['delete', 'read', 'update'],
      },
    ]);

    const rolesOf = async (id: string) =>
      (
        await db.query<{ name: string }[]>(
          `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name`,
          [id],
        )
      ).map((r) => r.name);
    expect(await rolesOf(admin.id)).toEqual(['admin']);
    expect(await rolesOf(roleless.id)).toEqual(['user']);
    expect(await rolesOf(pending.id)).toEqual([]);
    expect(await policyVersion(db)).toBeGreaterThan(before);
  });

  it('runs only once: a second run changes nothing', async () => {
    const other = await createUser(app);
    const before = await policyVersion(db);

    expect(await app.get(RbacBootstrap).run(other.id)).toBe('not_empty');
    expect(await policyVersion(db)).toBe(before);
    const [{ count }] = await db.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM user_roles WHERE user_id = $1`,
      [other.id],
    );
    expect(count).toBe(0);
  });

  it('runs at startup with RBAC_BOOTSTRAP_ADMIN_USER_ID', async () => {
    await wipeRbac(db);
    const admin = await createUser(app);

    const started = await createTestApp({
      logs,
      env: { RBAC_BOOTSTRAP_ADMIN_USER_ID: admin.id },
    });
    try {
      const [row] = await db.query<{ name: string }[]>(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [admin.id],
      );
      expect(row?.name).toBe('admin');
    } finally {
      await started.app.close();
    }
  });
});

describe('The access check on protected routes (spec 1.1 §1.3.1)', () => {
  let probeId: string;

  beforeAll(async () => {
    await ensureBootstrapped(app);
    // The probe routes need `probe@read` and `probe@write`; created once, kept across runs.
    await db.transaction(async (manager) => {
      const [existing] = await manager.query<{ id: string }[]>(
        `SELECT id FROM permissions WHERE name = 'probe'`,
      );
      probeId =
        existing?.id ??
        (
          await manager.query<{ id: string }[]>(
            `INSERT INTO permissions (name) VALUES ('probe') RETURNING id`,
          )
        )[0].id;
      await manager.query(
        `INSERT INTO permission_actions (permission_id, action) VALUES ($1, 'read'), ($1, 'write')
         ON CONFLICT DO NOTHING`,
        [probeId],
      );
      await manager.query(
        `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1`,
      );
    });
  });

  /** A new role with one grant on `probe`; `actions` undefined means all actions. */
  async function probeRole(actions?: string[]): Promise<string> {
    const name = uniqueName('probe-role');
    await db.transaction(async (manager) => {
      const [role] = await manager.query<{ id: string }[]>(
        `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
        [name],
      );
      const [grant] = await manager.query<{ id: string }[]>(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, $3) RETURNING id`,
        [role.id, probeId, actions === undefined],
      );
      for (const action of actions ?? []) {
        await manager.query(
          `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, $3)`,
          [grant.id, probeId, action],
        );
      }
      await manager.query(
        `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1`,
      );
    });
    return name;
  }

  const read = (actor: Actor) => call(actor, 'GET', '/__routes/protected');
  const write = (actor: Actor, headers?: Record<string, string>) =>
    call(actor, 'POST', '/__routes/protected', undefined, headers);

  it('runs the handler when a role grants the action', async () => {
    const actor = await actorWithRoles(app, [await probeRole(['read'])]);
    const before = calls.protected ?? 0;

    const res = await read(actor);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: 'protected' });
    expect(calls.protected).toBe(before + 1);
  });

  it('answers 403 permission_denied without running the handler when no role grants it', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const before = calls.protected ?? 0;

    const res = await read(actor);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'permission_denied' });
    expect(Object.keys(res.body).sort()).toEqual(
      ['code', 'message', 'requestId', 'statusCode'].sort(),
    );
    expect(calls.protected ?? 0).toBe(before);
  });

  it('answers 403 for a user with no roles at all', async () => {
    const actor = await actorWithRoles(app, []);

    expect((await read(actor)).status).toBe(403);
  });

  it('merges roles: one granting role among others is enough', async () => {
    const actor = await actorWithRoles(app, [
      'user',
      await probeRole(['read']),
    ]);

    expect((await read(actor)).status).toBe(200);
  });

  it('covers only the listed actions of a limited grant', async () => {
    const actor = await actorWithRoles(app, [await probeRole(['read'])]);

    expect((await read(actor)).status).toBe(200);
    expect((await write(actor)).status).toBe(403);
  });

  it('covers every action of an all-actions grant', async () => {
    const actor = await actorWithRoles(app, [await probeRole()]);

    expect((await read(actor)).status).toBe(200);
    expect((await write(actor)).status).toBe(201);
  });

  it('applies a policy change on the next request, with the same token', async () => {
    const role = await probeRole(['read']);
    const actor = await actorWithRoles(app, [role]);
    expect((await read(actor)).status).toBe(200);

    await db.query(`DELETE FROM user_roles WHERE user_id = $1`, [actor.id]);
    await bumpPolicy(db);

    expect((await read(actor)).status).toBe(403);
  });

  it('authenticates before RBAC: no session is 401, not 403', async () => {
    expect((await call(undefined, 'GET', '/__routes/protected')).status).toBe(
      401,
    );
  });

  it('checks CSRF on a protected write after identity: 403 csrf_rejected for an untrusted origin', async () => {
    const actor = await actorWithRoles(app, [await probeRole()]);
    const before = calls['protected-write'] ?? 0;

    const evil = await write(actor, { origin: 'https://evil.example' });
    const trustedNoHeader = await write(actor, {
      origin: config.CORS_ORIGINS[0],
    });
    const trusted = await write(actor, {
      origin: config.CORS_ORIGINS[0],
      'x-csrf-protection': '1',
    });

    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('csrf_rejected');
    expect(trustedNoHeader.status).toBe(403);
    expect(trusted.status).toBe(201);
    expect(calls['protected-write']).toBe(before + 1);
  });

  it('answers a protected write with no session 401 before CSRF', async () => {
    const res = await call(
      undefined,
      'POST',
      '/__routes/protected',
      undefined,
      {
        origin: 'https://evil.example',
      },
    );

    expect(res.status).toBe(401);
  });

  it('refuses everything with 503 while the snapshot cannot be loaded, and recovers', async () => {
    const actor = await actorWithRoles(app, [await probeRole()]);
    // An all-actions grant that also lists actions is incoherent: the reload must refuse it.
    const [grant] = await db.query<{ id: string }[]>(
      `SELECT g.id FROM grants g JOIN user_roles ur ON ur.role_id = g.role_id WHERE ur.user_id = $1`,
      [actor.id],
    );
    await db.query(
      `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'read')`,
      [grant.id, probeId],
    );
    await bumpPolicy(db);
    try {
      const res = await read(actor);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('authorization_unavailable');
      const ready = await request(app.getHttpServer()).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(
        (ready.body as { checks: Record<string, string> }).checks.rbac,
      ).toBe('down');
    } finally {
      await db.query(`DELETE FROM grant_actions WHERE grant_id = $1`, [
        grant.id,
      ]);
      await bumpPolicy(db);
    }

    expect((await read(actor)).status).toBe(200);
    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect((ready.body as { checks: Record<string, string> }).checks.rbac).toBe(
      'up',
    );
  });

  it('logs a refused check with the actor, permission and action', async () => {
    const actor = await actorWithRoles(app, []);
    logs.clear();

    await read(actor);

    expect(logs.lines()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'access_denied',
          actorUserId: actor.id,
          permission: 'probe',
          action: 'read',
        }),
      ]),
    );
  });
});

describe('The admin API (spec 1.1 §1.3.2–1.3.5)', () => {
  let admin: Actor;
  let plain: Actor;

  beforeAll(async () => {
    await ensureBootstrapped(app);
    admin = await actorWithRoles(app, ['admin']);
    plain = await actorWithRoles(app, ['user']);
  });

  describe('access', () => {
    it.each<['GET' | 'POST' | 'PUT' | 'DELETE', string]>([
      ['GET', '/admin/rbac/roles'],
      ['POST', '/admin/rbac/roles'],
      ['GET', '/admin/rbac/permissions'],
      ['GET', '/admin/rbac/grants'],
      ['GET', `/admin/rbac/users/${randomUUID()}/roles`],
      ['PUT', `/admin/rbac/users/${randomUUID()}/roles`],
      ['DELETE', `/admin/rbac/roles/${randomUUID()}`],
    ])(
      '%s %s: 401 without a session, 403 without rbac@manage (never 404)',
      async (method, url) => {
        const anonymous = await call(
          undefined,
          method,
          url,
          method === 'GET' ? undefined : {},
        );
        const user = await call(
          plain,
          method,
          url,
          method === 'GET' ? undefined : {},
        );

        expect(anonymous.status).toBe(401);
        expect(user.status).toBe(403);
        expect(user.body.code).toBe('permission_denied');
      },
    );
  });

  describe('roles', () => {
    it('creates a role: 201 with the normalized name and exactly the role fields', async () => {
      const name = uniqueName('role');
      const before = await policyVersion(db);

      const res = await call(admin, 'POST', '/admin/rbac/roles', {
        name: `  ${name.toUpperCase()} `,
        description: '  Handles tickets  ',
      });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        name,
        description: 'Handles tickets',
        createdAt: expect.stringMatching(ISO) as string,
        updatedAt: expect.stringMatching(ISO) as string,
      });
      expect(await policyVersion(db)).toBe(before + 1n);
    });

    it('stores an empty or missing description as null', async () => {
      const empty = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
        description: '   ',
      });
      const missing = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });

      expect(empty.body.description).toBeNull();
      expect(missing.body.description).toBeNull();
    });

    it.each<[string, Record<string, unknown>]>([
      ['no name', {}],
      ['an empty name', { name: '  ' }],
      ['a name starting with a digit', { name: '1role' }],
      ['a name with a space', { name: 'two words' }],
      ['a 65-character name', { name: `r${'a'.repeat(64)}` }],
      [
        'a 501-character description',
        { name: 'ok', description: 'x'.repeat(501) },
      ],
      ['an unknown field', { name: 'ok', permissions: [] }],
    ])('answers %s with 400', async (_name, body) => {
      const res = await call(admin, 'POST', '/admin/rbac/roles', body);

      expect(res.status).toBe(400);
    });

    it('answers a taken name with 409 name_taken, whatever its case, and changes nothing', async () => {
      const name = uniqueName('role');
      await call(admin, 'POST', '/admin/rbac/roles', { name });
      const before = await policyVersion(db);

      const res = await call(admin, 'POST', '/admin/rbac/roles', {
        name: name.toUpperCase(),
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('name_taken');
      expect(await policyVersion(db)).toBe(before);
    });

    it('lists roles', async () => {
      const created = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });

      const res = await call(admin, 'GET', '/admin/rbac/roles');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.arrayContaining([created.body]));
    });

    it('replaces the name and description', async () => {
      const created = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
        description: 'old',
      });
      const name = uniqueName('role');

      const res = await call(
        admin,
        'PUT',
        `/admin/rbac/roles/${String(created.body.id)}`,
        {
          name,
        },
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.body.id,
        name,
        description: null,
      });
    });

    it('answers a replace with a taken name with 409, an unknown id with 404, a bad id with 400', async () => {
      const a = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      const b = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });

      const taken = await call(
        admin,
        'PUT',
        `/admin/rbac/roles/${String(a.body.id)}`,
        {
          name: b.body.name,
        },
      );
      const missing = await call(
        admin,
        'PUT',
        `/admin/rbac/roles/${randomUUID()}`,
        {
          name: uniqueName('role'),
        },
      );
      const bad = await call(admin, 'PUT', '/admin/rbac/roles/not-a-uuid', {
        name: uniqueName('role'),
      });

      expect(taken.status).toBe(409);
      expect(missing.status).toBe(404);
      expect(bad.status).toBe(400);
    });

    it('deletes an unused role: 204, no body', async () => {
      const created = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });

      const res = await call(
        admin,
        'DELETE',
        `/admin/rbac/roles/${String(created.body.id)}`,
      );
      const again = await call(
        admin,
        'DELETE',
        `/admin/rbac/roles/${String(created.body.id)}`,
      );

      expect(res.status).toBe(204);
      expect(res.raw).toBe('');
      expect(again.status).toBe(404);
    });

    it('refuses to delete a role that has grants or users: 409 resource_in_use', async () => {
      const userRole = await roleId(db, 'user');
      const withGrants = await call(
        admin,
        'DELETE',
        `/admin/rbac/roles/${userRole}`,
      );

      const assigned = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      const someone = await createUser(app);
      await call(admin, 'PUT', `/admin/rbac/users/${someone.id}/roles`, {
        roleIds: [assigned.body.id],
      });
      const withUsers = await call(
        admin,
        'DELETE',
        `/admin/rbac/roles/${String(assigned.body.id)}`,
      );

      expect(withGrants.status).toBe(409);
      expect(withGrants.body.code).toBe('resource_in_use');
      expect(withUsers.status).toBe(409);
      expect(withUsers.body.code).toBe('resource_in_use');
    });
  });

  it('keeps the default role: `user` cannot be renamed or deleted (activation finds it by name)', async () => {
    const userRole = await roleId(db, 'user');

    const renamed = await call(admin, 'PUT', `/admin/rbac/roles/${userRole}`, {
      name: 'member',
    });
    const deleted = await call(
      admin,
      'DELETE',
      `/admin/rbac/roles/${userRole}`,
    );

    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('resource_in_use');
    expect(deleted.status).toBe(409);
  });

  describe('permissions', () => {
    it('creates a permission with normalized actions', async () => {
      const name = uniqueName('perm');

      const res = await call(admin, 'POST', '/admin/rbac/permissions', {
        name,
        actions: [' Read ', 'WRITE'],
      });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        name,
        description: null,
        actions: ['read', 'write'],
        createdAt: expect.stringMatching(ISO) as string,
        updatedAt: expect.stringMatching(ISO) as string,
      });
    });

    it.each<[string, unknown]>([
      ['no actions', undefined],
      ['an empty action list', []],
      ['a repeated action', ['read', 'read']],
      ['an action repeated after normalization', ['read', ' READ']],
      ['an invalid action', ['read all']],
      ['65 actions', Array.from({ length: 65 }, (_, i) => `a${i}`)],
    ])('answers %s with 400', async (_name, actions) => {
      const res = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: uniqueName('perm'),
        ...(actions === undefined ? {} : { actions }),
      });

      expect(res.status).toBe(400);
    });

    it('answers a taken name with 409 name_taken', async () => {
      const res = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: 'users',
        actions: ['read'],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('name_taken');
    });

    it('lists permissions with their actions', async () => {
      const res = await call(admin, 'GET', '/admin/rbac/permissions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'rbac', actions: ['manage'] }),
        ]),
      );
    });

    it('replaces the action set; a new action joins all-actions grants only', async () => {
      const perm = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: uniqueName('perm'),
        actions: ['read', 'write'],
      });
      const roleAll = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      const roleListed = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      await call(admin, 'POST', '/admin/rbac/grants', {
        roleId: roleAll.body.id,
        permissionId: perm.body.id,
      });
      await call(admin, 'POST', '/admin/rbac/grants', {
        roleId: roleListed.body.id,
        permissionId: perm.body.id,
        actions: ['read'],
      });

      // Removing `write` is fine: no grant lists it explicitly.
      const res = await call(
        admin,
        'PUT',
        `/admin/rbac/permissions/${String(perm.body.id)}`,
        {
          name: perm.body.name,
          actions: ['read', 'export'],
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.actions).toEqual(['export', 'read']);
      const grants = (await call(admin, 'GET', '/admin/rbac/grants'))
        .body as unknown as {
        roleId: string;
        allActions: boolean;
        actions: string[];
      }[];
      expect(grants.find((g) => g.roleId === roleAll.body.id)).toMatchObject({
        allActions: true,
        actions: [],
      });
      expect(grants.find((g) => g.roleId === roleListed.body.id)).toMatchObject(
        {
          allActions: false,
          actions: ['read'],
        },
      );
    });

    it('refuses to remove an action a grant lists explicitly: 409, nothing changed', async () => {
      const perm = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: uniqueName('perm'),
        actions: ['read', 'write'],
      });
      const role = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      await call(admin, 'POST', '/admin/rbac/grants', {
        roleId: role.body.id,
        permissionId: perm.body.id,
        actions: ['write'],
      });
      const before = await policyVersion(db);

      const res = await call(
        admin,
        'PUT',
        `/admin/rbac/permissions/${String(perm.body.id)}`,
        {
          name: perm.body.name,
          actions: ['read'],
        },
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('resource_in_use');
      expect(await policyVersion(db)).toBe(before);
      const list = (await call(admin, 'GET', '/admin/rbac/permissions'))
        .body as unknown as {
        id: string;
        actions: string[];
      }[];
      expect(list.find((p) => p.id === perm.body.id)?.actions).toEqual([
        'read',
        'write',
      ]);
    });

    it('deletes an ungranted permission, and refuses a granted one with 409', async () => {
      const free = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: uniqueName('perm'),
        actions: ['read'],
      });
      const usersId = (
        await db.query<{ id: string }[]>(
          `SELECT id FROM permissions WHERE name = 'users'`,
        )
      )[0].id;

      const deleted = await call(
        admin,
        'DELETE',
        `/admin/rbac/permissions/${String(free.body.id)}`,
      );
      const granted = await call(
        admin,
        'DELETE',
        `/admin/rbac/permissions/${usersId}`,
      );
      const missing = await call(
        admin,
        'DELETE',
        `/admin/rbac/permissions/${randomUUID()}`,
      );

      expect(deleted.status).toBe(204);
      expect(granted.status).toBe(409);
      expect(granted.body.code).toBe('resource_in_use');
      expect(missing.status).toBe(404);
    });
  });

  describe('grants', () => {
    async function pair() {
      const perm = await call(admin, 'POST', '/admin/rbac/permissions', {
        name: uniqueName('perm'),
        actions: ['read', 'write'],
      });
      const role = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });
      return {
        permissionId: perm.body.id as string,
        roleId: role.body.id as string,
      };
    }

    it('creates an all-actions grant without actions: allActions true, actions []', async () => {
      const ids = await pair();

      const res = await call(admin, 'POST', '/admin/rbac/grants', ids);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        ...ids,
        allActions: true,
        actions: [],
        createdAt: expect.stringMatching(ISO) as string,
        updatedAt: expect.stringMatching(ISO) as string,
      });
    });

    it('treats an empty action list as all actions', async () => {
      const res = await call(admin, 'POST', '/admin/rbac/grants', {
        ...(await pair()),
        actions: [],
      });

      expect(res.body).toMatchObject({ allActions: true, actions: [] });
    });

    it('creates a limited grant with normalized actions', async () => {
      const res = await call(admin, 'POST', '/admin/rbac/grants', {
        ...(await pair()),
        actions: [' WRITE'],
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ allActions: false, actions: ['write'] });
    });

    it('answers an action the permission does not have with 400', async () => {
      const res = await call(admin, 'POST', '/admin/rbac/grants', {
        ...(await pair()),
        actions: ['delete'],
      });

      expect(res.status).toBe(400);
    });

    it('answers an unknown role or permission with 404', async () => {
      const ids = await pair();

      const role = await call(admin, 'POST', '/admin/rbac/grants', {
        ...ids,
        roleId: randomUUID(),
      });
      const perm = await call(admin, 'POST', '/admin/rbac/grants', {
        ...ids,
        permissionId: randomUUID(),
      });

      expect(role.status).toBe(404);
      expect(perm.status).toBe(404);
    });

    it('allows one grant per role and permission: 409 grant_exists', async () => {
      const ids = await pair();
      await call(admin, 'POST', '/admin/rbac/grants', ids);

      const res = await call(admin, 'POST', '/admin/rbac/grants', {
        ...ids,
        actions: ['read'],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('grant_exists');
    });

    it('replaces a grant, lists it, and deletes it', async () => {
      const ids = await pair();
      const created = await call(admin, 'POST', '/admin/rbac/grants', ids);

      const replaced = await call(
        admin,
        'PUT',
        `/admin/rbac/grants/${String(created.body.id)}`,
        {
          ...ids,
          actions: ['read'],
        },
      );
      const listed = await call(admin, 'GET', '/admin/rbac/grants');
      const deleted = await call(
        admin,
        'DELETE',
        `/admin/rbac/grants/${String(created.body.id)}`,
      );
      const again = await call(
        admin,
        'DELETE',
        `/admin/rbac/grants/${String(created.body.id)}`,
      );

      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({
        allActions: false,
        actions: ['read'],
      });
      expect(listed.body).toEqual(expect.arrayContaining([replaced.body]));
      expect(deleted.status).toBe(204);
      expect(again.status).toBe(404);
    });
  });

  describe('user roles', () => {
    it('reads and replaces a user’s roles; an empty list removes them all', async () => {
      const someone = await createUser(app);
      const userRole = await roleId(db, 'user');
      const extra = await call(admin, 'POST', '/admin/rbac/roles', {
        name: uniqueName('role'),
      });

      const set = await call(
        admin,
        'PUT',
        `/admin/rbac/users/${someone.id}/roles`,
        {
          roleIds: [userRole, extra.body.id],
        },
      );
      const read = await call(
        admin,
        'GET',
        `/admin/rbac/users/${someone.id}/roles`,
      );
      const cleared = await call(
        admin,
        'PUT',
        `/admin/rbac/users/${someone.id}/roles`,
        {
          roleIds: [],
        },
      );

      expect(set.status).toBe(200);
      expect(set.body).toEqual({
        userId: someone.id,
        roleIds: [userRole, extra.body.id].sort(),
      });
      expect(read.body).toEqual(set.body);
      expect(cleared.body).toEqual({ userId: someone.id, roleIds: [] });
      expect(JSON.stringify(read.body)).not.toContain(someone.email);
    });

    it('answers an unknown user or role with 404, a repeated role with 400', async () => {
      const someone = await createUser(app);
      const userRole = await roleId(db, 'user');

      const noUser = await call(
        admin,
        'GET',
        `/admin/rbac/users/${randomUUID()}/roles`,
      );
      const noUserPut = await call(
        admin,
        'PUT',
        `/admin/rbac/users/${randomUUID()}/roles`,
        {
          roleIds: [],
        },
      );
      const noRole = await call(
        admin,
        'PUT',
        `/admin/rbac/users/${someone.id}/roles`,
        {
          roleIds: [randomUUID()],
        },
      );
      const repeated = await call(
        admin,
        'PUT',
        `/admin/rbac/users/${someone.id}/roles`,
        {
          roleIds: [userRole, userRole],
        },
      );

      expect(noUser.status).toBe(404);
      expect(noUserPut.status).toBe(404);
      expect(noRole.status).toBe(404);
      expect(repeated.status).toBe(400);
    });

    it('takes effect on the next request of that user', async () => {
      const target = await actorWithRoles(app, ['user']);
      expect((await call(target, 'GET', '/admin/rbac/roles')).status).toBe(403);

      await call(admin, 'PUT', `/admin/rbac/users/${target.id}/roles`, {
        roleIds: [await roleId(db, 'admin')],
      });

      expect((await call(target, 'GET', '/admin/rbac/roles')).status).toBe(200);
    });
  });

  describe('at least one active rbac@manage holder (spec 1.1 §1.1)', () => {
    it('refuses to delete the grant that gives every admin rbac@manage: 409, rolled back', async () => {
      const [grant] = await db.query<{ id: string }[]>(
        `SELECT g.id FROM grants g JOIN roles r ON r.id = g.role_id JOIN permissions p ON p.id = g.permission_id
          WHERE r.name = 'admin' AND p.name = 'rbac'`,
      );
      const before = await policyVersion(db);

      const res = await call(admin, 'DELETE', `/admin/rbac/grants/${grant.id}`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_rbac_manager');
      expect(await policyVersion(db)).toBe(before);
      const [{ count }] = await db.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM grants WHERE id = $1`,
        [grant.id],
      );
      expect(count).toBe(1);
      expect((await call(admin, 'GET', '/admin/rbac/roles')).status).toBe(200);
    });

    it('refuses to rename the rbac permission away', async () => {
      const [perm] = await db.query<{ id: string }[]>(
        `SELECT id FROM permissions WHERE name = 'rbac'`,
      );

      const res = await call(
        admin,
        'PUT',
        `/admin/rbac/permissions/${perm.id}`,
        {
          name: 'rbac-old',
          actions: ['manage'],
        },
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_rbac_manager');
    });

    it('refuses to replace the admin grant with one that lacks manage', async () => {
      const [grant] = await db.query<
        { id: string; role_id: string; permission_id: string }[]
      >(
        `SELECT g.id, g.role_id, g.permission_id FROM grants g JOIN roles r ON r.id = g.role_id
           JOIN permissions p ON p.id = g.permission_id WHERE r.name = 'admin' AND p.name = 'rbac'`,
      );
      // Give the permission a second action so the grant can list only that one.
      const [perm] = await db.query<{ name: string }[]>(
        `SELECT name FROM permissions WHERE id = $1`,
        [grant.permission_id],
      );
      await call(
        admin,
        'PUT',
        `/admin/rbac/permissions/${grant.permission_id}`,
        {
          name: perm.name,
          actions: ['manage', 'audit'],
        },
      );

      const res = await call(admin, 'PUT', `/admin/rbac/grants/${grant.id}`, {
        roleId: grant.role_id,
        permissionId: grant.permission_id,
        actions: ['audit'],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_rbac_manager');
      await call(
        admin,
        'PUT',
        `/admin/rbac/permissions/${grant.permission_id}`,
        {
          name: perm.name,
          actions: ['manage'],
        },
      );
    });
  });

  it('logs admin changes with the actor, entity and version, never the description', async () => {
    logs.clear();
    const description = `secret plan ${randomUUID()}`;
    sent.push(description);

    const created = await call(admin, 'POST', '/admin/rbac/roles', {
      name: uniqueName('role'),
      description,
    });

    expect(logs.lines()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'rbac_change',
          actorUserId: admin.id,
          operation: 'create',
          entityType: 'role',
          entityId: created.body.id,
          version: expect.any(String) as string,
          result: 'success',
        }),
      ]),
    );
  });
});

describe('The default role on activation (spec 1.0, 1.1)', () => {
  const rolesOf = async (userId: string) =>
    (
      await db.query<{ name: string }[]>(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [userId],
      )
    ).map((r) => r.name);

  beforeAll(async () => {
    await ensureBootstrapped(app);
  });

  it('gives `user` to a registration that is active at once', async () => {
    const email = `rbac-${randomUUID()}@example.com`;
    sent.push(email);

    const res = await send(app, '/auth/register', {
      body: { email, password: PASSWORD },
    });

    expect(res.status).toBe(201);
    expect(await rolesOf(res.body.id as string)).toEqual(['user']);
  });

  it('gives `user` only when a pending registration is confirmed', async () => {
    const confirming = await createTestApp({
      logs,
      env: { REGISTRATION_EMAIL_CONFIRMATION_ENABLED: 'true' },
    });
    try {
      const email = `rbac-${randomUUID()}@example.com`;
      sent.push(email);
      await send(confirming.app, '/auth/register', {
        body: { email, password: PASSWORD },
      });
      const [user] = await db.query<{ id: string }[]>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      );
      expect(await rolesOf(user.id)).toEqual([]);

      const mail = await waitForMail(email);
      const code = /\b(\d{6})\b/.exec(mail.text)?.[1] ?? '';
      sent.push(code);
      const [challenge] = await db.query<{ id: string }[]>(
        `SELECT id FROM registration_challenges WHERE user_id = $1`,
        [user.id],
      );
      const confirmed = await send(confirming.app, '/auth/register/confirm', {
        body: { attemptId: challenge.id, code },
      });

      expect(confirmed.status).toBe(200);
      expect(await rolesOf(user.id)).toEqual(['user']);
    } finally {
      await confirming.app.close();
    }
  });
});
