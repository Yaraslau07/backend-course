import { type ExecutionContext, Logger } from '@nestjs/common';
import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';

import { currentUserId } from '@/core/authorization/current-user';
import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { ReadinessRegistry } from '@/core/health/readiness.registry';

import type { PolicyRows } from './policy-snapshot';
import { RbacAdminController } from './rbac-admin.controller';
import { RbacAdminService } from './rbac-admin.service';
import { RbacAuthorizer } from './rbac-authorizer';
import { RbacBootstrap } from './rbac-bootstrap';
import { RbacPolicyStore } from './rbac-policy.store';

/**
 * The RBAC services with the database scripted by SQL. The real behaviour, against Postgres, is
 * in test/rbac.e2e-spec.ts; these pin down the branches e2e can't reach cheaply (outages, races).
 */
const USER = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const ROLE = '9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d';
const PERM = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

type Responder = (sql: string, params?: unknown[]) => unknown;

/** A query function answering by the first matching SQL fragment; unmatched queries get `[]`. */
function scripted(routes: [RegExp, unknown][]) {
  return jest.fn((sql: string, params?: unknown[]) => {
    for (const [pattern, answer] of routes) {
      if (pattern.test(sql)) {
        const value =
          typeof answer === 'function'
            ? (answer as Responder)(sql, params)
            : answer;
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value);
      }
    }
    return Promise.resolve([]);
  });
}

function dataSource(query: ReturnType<typeof scripted>) {
  const manager = { query } as unknown as EntityManager;
  return {
    manager,
    query,
    transaction: jest.fn(
      (
        levelOrWork: string | ((m: EntityManager) => Promise<unknown>),
        work?: (m: EntityManager) => Promise<unknown>,
      ) =>
        typeof levelOrWork === 'function'
          ? levelOrWork(manager)
          : work!(manager),
    ),
  } as unknown as DataSource & { transaction: jest.Mock };
}

const outage = () =>
  Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });

const uniqueViolation = (constraint: string) =>
  new QueryFailedError('INSERT', [], {
    code: '23505',
    constraint,
  } as unknown as Error);
const foreignKeyViolation = () =>
  new QueryFailedError('DELETE', [], { code: '23503' } as unknown as Error);

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return 'resolved';
}

const policy = (
  version: string,
): Omit<PolicyRows, 'version'> & { version: string } => ({
  version,
  roles: [{ id: ROLE, name: 'reader' }],
  permissions: [{ id: PERM, name: 'docs' }],
  permissionActions: [{ permission_id: PERM, action: 'read' }],
  grants: [{ id: 'g', role_id: ROLE, permission_id: PERM, all_actions: true }],
  grantActions: [],
});

/** Routes for a policy read at `state.version`, with the tables of `state.rows`. */
function policyRoutes(state: {
  version: string;
  rows: ReturnType<typeof policy>;
  fail?: Error;
}): [RegExp, Responder][] {
  return [
    [
      /SELECT version FROM rbac_policy_state/,
      () => (state.fail ? state.fail : [{ version: state.version }]),
    ],
    [/SELECT id, name FROM roles/, () => state.rows.roles],
    [/SELECT id, name FROM permissions/, () => state.rows.permissions],
    [/FROM permission_actions/, () => state.rows.permissionActions],
    [/FROM grants/, () => state.rows.grants],
    [/FROM grant_actions/, () => state.rows.grantActions],
  ];
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});

afterEach(() => jest.restoreAllMocks());

describe('RbacPolicyStore', () => {
  function setup(state: Parameters<typeof policyRoutes>[0]) {
    const query = scripted(policyRoutes(state));
    const db = dataSource(query);
    let check: (() => Promise<unknown>) | undefined;
    const readiness = {
      register: (_name: string, fn: () => Promise<unknown>) => {
        check = fn;
      },
    } as unknown as ReadinessRegistry;
    const bootstrap = { run: jest.fn().mockResolvedValue('not_empty') };
    const config = {
      get: () => USER,
    } as unknown as ConfigService;
    const store = new RbacPolicyStore(
      db,
      readiness,
      bootstrap as unknown as RbacBootstrap,
      config,
    );
    store.onModuleInit();
    return { store, db, bootstrap, readiness: () => check!() };
  }

  it('bootstraps with the configured admin, then loads; readiness is up', async () => {
    const { store, bootstrap, readiness } = setup({
      version: '3',
      rows: policy('3'),
    });

    await store.onApplicationBootstrap();

    expect(bootstrap.run).toHaveBeenCalledWith(USER);
    expect(await readiness()).toBe('up');
    expect((await store.current()).version).toBe('3');
  });

  it('does not serve the empty policy when the bootstrap fails; the next load retries it', async () => {
    const { store, bootstrap, readiness } = setup({
      version: '1',
      rows: policy('1'),
    });
    bootstrap.run.mockRejectedValueOnce(new Error('db not ready'));

    await store.onApplicationBootstrap();
    expect(bootstrap.run).toHaveBeenCalledTimes(1);

    // Readiness itself tries again, so an instance out of rotation recovers on its own.
    expect(await readiness()).toBe('up');
    expect(bootstrap.run).toHaveBeenCalledTimes(2);
    await store.current();
    expect(bootstrap.run).toHaveBeenCalledTimes(2);
  });

  it('loads from the readiness check when there is no snapshot yet', async () => {
    const state = {
      version: '1',
      rows: policy('1'),
      fail: outage() as Error | undefined,
    };
    const { store, readiness } = setup(state);
    await store.onApplicationBootstrap();
    expect(await readiness()).toEqual({ down: 'policy_not_loaded' });

    state.fail = undefined;

    expect(await readiness()).toBe('up');
  });

  it('reuses the snapshot while the version is unchanged', async () => {
    const state = { version: '5', rows: policy('5') };
    const { store, db } = setup(state);
    await store.current();
    const reads = db.transaction.mock.calls.length;

    await store.current();

    expect(db.transaction.mock.calls.length).toBe(reads);
  });

  it('reloads in REPEATABLE READ when the version moves', async () => {
    const state = { version: '5', rows: policy('5') };
    const { store, db } = setup(state);
    await store.current();

    state.version = '6';
    state.rows = policy('6');

    expect((await store.current()).version).toBe('6');
    expect(db.transaction).toHaveBeenLastCalledWith(
      'REPEATABLE READ',
      expect.any(Function),
    );
  });

  it('shares one reload between concurrent requests', async () => {
    const { store, db } = setup({ version: '2', rows: policy('2') });

    await Promise.all([store.current(), store.current(), store.current()]);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('drops the snapshot and answers 503 while the policy is incoherent, then recovers', async () => {
    const state = { version: '1', rows: policy('1') };
    const { store, readiness } = setup(state);
    await store.current();

    state.version = '2';
    state.rows = {
      ...policy('2'),
      grantActions: [{ grant_id: 'g', permission_id: PERM, action: 'read' }],
    };
    expect(await codeOf(() => store.current())).toBe(
      'authorization_unavailable',
    );
    expect(await readiness()).toEqual({ down: 'policy_not_loaded' });

    state.version = '3';
    state.rows = policy('3');
    expect((await store.current()).version).toBe('3');
    expect(await readiness()).toBe('up');
  });

  it('answers 503 when the version cannot be read for an outage, logged as rbac_version', async () => {
    const { store } = setup({
      version: '1',
      rows: policy('1'),
      fail: outage(),
    });
    const error = jest.spyOn(Logger.prototype, 'error');

    expect(await codeOf(() => store.current())).toBe(
      'authorization_unavailable',
    );
    expect(
      (error.mock.calls as unknown[][]).map(([fields]) => fields),
    ).toContainEqual(expect.objectContaining({ category: 'rbac_version' }));
  });

  it('logs a failed reload as rbac_snapshot', async () => {
    const state = { version: '1', rows: policy('1') };
    const { store } = setup(state);
    await store.current();
    state.version = '2';
    state.rows = {
      ...policy('2'),
      grants: [],
      grantActions: [{ grant_id: 'x', permission_id: PERM, action: 'read' }],
    };
    const error = jest.spyOn(Logger.prototype, 'error');

    await codeOf(() => store.current());

    expect(
      (error.mock.calls as unknown[][]).map(([fields]) => fields),
    ).toContainEqual(expect.objectContaining({ category: 'rbac_snapshot' }));
  });

  it('answers 503 when the policy state row is missing', async () => {
    const query = scripted([[/SELECT version FROM rbac_policy_state/, []]]);
    const store = new RbacPolicyStore(
      dataSource(query),
      { register: jest.fn() } as unknown as ReadinessRegistry,
      { run: jest.fn() } as unknown as RbacBootstrap,
      { get: jest.fn() } as unknown as ConfigService,
    );

    expect(await codeOf(() => store.current())).toBe(
      'authorization_unavailable',
    );
  });

  it('lets an error that is not an outage through (a 500, not a 503)', async () => {
    const bug = new TypeError('boom');
    const { store } = setup({ version: '1', rows: policy('1'), fail: bug });

    await expect(store.current()).rejects.toBe(bug);
  });
});

describe('RbacAuthorizer', () => {
  function setup(roles: unknown) {
    const query = scripted([[/FROM user_roles/, roles]]);
    const store = {
      current: jest.fn().mockResolvedValue({
        version: '9',
        allows: (ids: string[], permission: string, action: string) =>
          ids.includes(ROLE) && permission === 'docs' && action === 'read'
            ? 'allowed'
            : 'no_grant',
      }),
    };
    return new RbacAuthorizer(
      dataSource(query),
      store as unknown as RbacPolicyStore,
    );
  }

  it('resolves when a role of the user allows the pair, and logs the admission (spec 1.3 §1.5)', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');

    await expect(
      setup([{ role_id: ROLE }]).authorize(USER, 'docs', 'read', 'Docs.read'),
    ).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toEqual({
      event: 'rbac_decision',
      result: 'allowed',
      actorUserId: USER,
      operation: 'Docs.read',
      permission: 'docs',
      action: 'read',
      version: '9',
    });
  });

  it('refuses with 403 permission_denied and logs the actor, operation, pair and version', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');

    expect(
      await codeOf(() =>
        setup([]).authorize(USER, 'docs', 'read', 'Docs.read'),
      ),
    ).toBe('permission_denied');
    expect(warn.mock.calls[0][0]).toEqual({
      event: 'rbac_decision',
      result: 'denied',
      category: 'permission_denied',
      reason: 'no_grant',
      actorUserId: USER,
      operation: 'Docs.read',
      permission: 'docs',
      action: 'read',
      version: '9',
    });
  });

  it('answers allows() with true or false instead of throwing', async () => {
    expect(
      await setup([{ role_id: ROLE }]).allows(USER, 'docs', 'read', 'op'),
    ).toBe(true);
    expect(await setup([]).allows(USER, 'docs', 'read', 'op')).toBe(false);
  });

  it('still throws 503 from allows() when the roles cannot be read', async () => {
    expect(
      await codeOf(() => setup(outage()).allows(USER, 'docs', 'read', 'op')),
    ).toBe('authorization_unavailable');
  });

  it('logs a roles outage with the users dependency category', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');

    await codeOf(() => setup(outage()).authorize(USER, 'docs', 'read', 'op'));

    expect(error.mock.calls[0][0]).toMatchObject({ category: 'users' });
  });

  it('answers 503 when the user roles cannot be read', async () => {
    expect(
      await codeOf(() => setup(outage()).authorize(USER, 'docs', 'read')),
    ).toBe('authorization_unavailable');
  });

  it('lets a bug through', async () => {
    const bug = new TypeError('boom');
    await expect(setup(bug).authorize(USER, 'docs', 'read')).rejects.toBe(bug);
  });

  it('assigns the default role once', async () => {
    const insert = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: USER }])
      .mockResolvedValueOnce([]);
    const manager = { query: insert } as unknown as EntityManager;
    const authorizer = setup([]);

    await authorizer.assignDefaultRole(manager, USER);
    await authorizer.assignDefaultRole(manager, USER);

    expect(insert).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT DO NOTHING'),
      [USER, 'user'],
    );
  });
});

describe('RbacBootstrap', () => {
  function setup(options: { empty: boolean; admin?: { status: string } }) {
    const query = scripted([
      [/AS empty/, [{ empty: options.empty }]],
      [/SELECT status FROM users/, options.admin ? [options.admin] : []],
      [/INSERT INTO (permissions|roles|grants)/, () => [{ id: randomId() }]],
      [
        /INSERT INTO user_roles[\s\S]*SELECT u.id/,
        [{ user_id: 'a' }, { user_id: 'b' }],
      ],
      [/UPDATE rbac_policy_state/, [[{ version: '1' }], 1]],
    ]);
    return { bootstrap: new RbacBootstrap(dataSource(query)), query };
  }
  let counter = 0;
  const randomId = () => `id-${++counter}`;

  it('skips a policy that is not empty', async () => {
    const { bootstrap, query } = setup({ empty: false });

    expect(await bootstrap.run(USER)).toBe('not_empty');
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT'),
      expect.anything(),
    );
  });

  it('skips without an admin, or with one that is not active', async () => {
    expect(await setup({ empty: true }).bootstrap.run(undefined)).toBe(
      'no_admin_configured',
    );
    expect(await setup({ empty: true }).bootstrap.run(USER)).toBe(
      'admin_not_active',
    );
    expect(
      await setup({ empty: true, admin: { status: 'pending' } }).bootstrap.run(
        USER,
      ),
    ).toBe('admin_not_active');
  });

  it('seeds the spec policy and bumps the version', async () => {
    const { bootstrap, query } = setup({
      empty: true,
      admin: { status: 'active' },
    });

    expect(await bootstrap.run(USER)).toBe('bootstrapped');

    const sql = query.mock.calls.map(([text]) => text);
    expect(sql[0]).toMatch(/FOR UPDATE/);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO permission_actions'),
      [expect.any(String), ['manage']],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO grant_actions'),
      [expect.any(String), expect.any(String), ['read', 'update', 'delete']],
    );
    expect(sql[sql.length - 1]).toMatch(/UPDATE rbac_policy_state/);
  });
});

describe('RbacAdminService', () => {
  const NOW = new Date('2026-11-17T10:00:00.000Z');
  const roleRow = {
    id: ROLE,
    name: 'reader',
    description: null,
    created_at: NOW,
    updated_at: NOW,
  };

  function setup(routes: [RegExp, unknown][], holder = true) {
    const query = scripted([
      [/AS ok/, [{ ok: holder }]],
      [/UPDATE rbac_policy_state/, [[{ version: '12' }], 1]],
      ...routes,
    ]);
    return { service: new RbacAdminService(dataSource(query)), query };
  }

  it('creates a role inside the locked, versioned transaction', async () => {
    const { service, query } = setup([[/INSERT INTO roles/, [roleRow]]]);

    expect(
      await service.createRole(USER, { name: 'reader', description: null }),
    ).toEqual({
      id: ROLE,
      name: 'reader',
      description: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const sql = query.mock.calls.map(([text]) => text);
    expect(sql[0]).toMatch(/rbac_policy_state[\s\S]*FOR UPDATE/);
    expect(sql[sql.length - 1]).toMatch(/version = version \+ 1/);
  });

  it('rolls back with 409 last_rbac_manager when no holder would remain', async () => {
    const { service, query } = setup([[/DELETE FROM grants/, [[], 1]]], false);

    expect(await codeOf(() => service.deleteGrant(USER, ROLE))).toBe(
      'last_rbac_manager',
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('version = version + 1'),
    );
  });

  it.each<[string, Error, string]>([
    ['a taken role name', uniqueViolation('uq_roles_name'), 'name_taken'],
    [
      'a taken permission name',
      uniqueViolation('uq_permissions_name'),
      'name_taken',
    ],
    ['another unique constraint', uniqueViolation('uq_other'), 'conflict'],
  ])('maps %s to its 409', async (_name, error, code) => {
    const { service } = setup([[/INSERT INTO roles/, error]]);

    expect(
      await codeOf(() =>
        service.createRole(USER, { name: 'reader', description: null }),
      ),
    ).toBe(code);
  });

  it('keeps the default role: renaming or deleting `user` is 409 resource_in_use', async () => {
    const { service } = setup([
      [/SELECT name FROM roles WHERE id/, [{ name: 'user' }]],
    ]);

    expect(
      await codeOf(() =>
        service.replaceRole(USER, ROLE, { name: 'member', description: null }),
      ),
    ).toBe('resource_in_use');
    expect(await codeOf(() => service.deleteRole(USER, ROLE))).toBe(
      'resource_in_use',
    );
  });

  it('lets `user` keep its name while its description changes', async () => {
    const { service } = setup([
      [/SELECT name FROM roles WHERE id/, [{ name: 'user' }]],
      [
        /UPDATE roles/,
        [[{ ...roleRow, name: 'user', description: 'everyone' }], 1],
      ],
    ]);

    expect(
      await service.replaceRole(USER, ROLE, {
        name: 'user',
        description: 'everyone',
      }),
    ).toMatchObject({ name: 'user', description: 'everyone' });
  });

  it('logs a refusal with errorCode (the logger redacts `code`)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service } = setup([[/DELETE FROM grants/, [[], 1]]], false);

    await codeOf(() => service.deleteGrant(USER, ROLE));

    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'rbac_change',
      result: 'failure',
      errorCode: 'last_rbac_manager',
    });
  });

  it('maps a foreign-key refusal to 409 resource_in_use', async () => {
    const { service } = setup([[/DELETE FROM roles/, foreignKeyViolation()]]);

    expect(await codeOf(() => service.deleteRole(USER, ROLE))).toBe(
      'resource_in_use',
    );
  });

  it('lets an unexpected error through unchanged', async () => {
    const bug = new TypeError('boom');
    const { service } = setup([[/DELETE FROM roles/, bug]]);

    await expect(service.deleteRole(USER, ROLE)).rejects.toBe(bug);
  });

  it.each<[string, (s: RbacAdminService) => Promise<unknown>, RegExp]>([
    [
      'replacing a role',
      (s) => s.replaceRole(USER, ROLE, { name: 'x', description: null }),
      /UPDATE roles/,
    ],
    ['deleting a role', (s) => s.deleteRole(USER, ROLE), /DELETE FROM roles/],
    [
      'replacing a permission',
      (s) =>
        s.replacePermission(USER, PERM, {
          name: 'x',
          description: null,
          actions: ['read'],
        }),
      /UPDATE permissions/,
    ],
    [
      'deleting a permission',
      (s) => s.deletePermission(USER, PERM),
      /DELETE FROM permissions/,
    ],
    [
      'deleting a grant',
      (s) => s.deleteGrant(USER, ROLE),
      /DELETE FROM grants/,
    ],
  ])('answers 404 when %s that does not exist', async (_name, run, pattern) => {
    const { service } = setup([[pattern, [[], 0]]]);

    expect(await codeOf(() => run(service))).toBe('not_found');
  });

  describe('grants', () => {
    const grantRow = (allActions: boolean, actions: string[]) => ({
      id: 'g1',
      role_id: ROLE,
      permission_id: PERM,
      all_actions: allActions,
      actions,
      created_at: NOW,
      updated_at: NOW,
    });

    const targets = (
      role: unknown[],
      permission: unknown[],
    ): [RegExp, unknown][] => [
      [/SELECT id FROM roles WHERE id/, role],
      [/AS actions\s+FROM permissions p WHERE p.id/, permission],
    ];

    it('creates an all-actions grant for no actions, and shows actions as []', async () => {
      const { service, query } = setup([
        ...targets([{ id: ROLE }], [{ actions: ['read'] }]),
        [/INSERT INTO grants/, [{ id: 'g1' }]],
        [/WHERE g.id = \$1/, [grantRow(true, [])]],
      ]);

      const view = await service.createGrant(USER, {
        roleId: ROLE,
        permissionId: PERM,
      });

      expect(view).toMatchObject({ allActions: true, actions: [] });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO grants'),
        [ROLE, PERM, true],
      );
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO grant_actions'),
        expect.anything(),
      );
    });

    it('answers a missing role or permission with 404', async () => {
      const noRole = setup(targets([], [{ actions: ['read'] }])).service;
      const noPerm = setup(targets([{ id: ROLE }], [])).service;
      const dto = { roleId: ROLE, permissionId: PERM };

      expect(await codeOf(() => noRole.createGrant(USER, dto))).toBe(
        'not_found',
      );
      expect(await codeOf(() => noPerm.createGrant(USER, dto))).toBe(
        'not_found',
      );
    });

    it('answers an action outside the permission with 400', async () => {
      const { service } = setup(
        targets([{ id: ROLE }], [{ actions: ['read'] }]),
      );

      expect(
        await codeOf(() =>
          service.createGrant(USER, {
            roleId: ROLE,
            permissionId: PERM,
            actions: ['write'],
          }),
        ),
      ).toBe('validation_failed');
    });

    it('maps the duplicate pair to 409 grant_exists', async () => {
      const { service } = setup([
        ...targets([{ id: ROLE }], [{ actions: ['read'] }]),
        [/INSERT INTO grants/, uniqueViolation('uq_grants_role_permission')],
      ]);

      expect(
        await codeOf(() =>
          service.createGrant(USER, { roleId: ROLE, permissionId: PERM }),
        ),
      ).toBe('grant_exists');
    });

    it('replaces a grant: listed actions are cleared before the grant moves', async () => {
      const { service, query } = setup([
        [/SELECT id FROM grants WHERE id/, [{ id: 'g1' }]],
        ...targets([{ id: ROLE }], [{ actions: ['read'] }]),
        [/WHERE g.id = \$1/, [grantRow(false, ['read'])]],
      ]);

      const view = await service.replaceGrant(USER, 'g1', {
        roleId: ROLE,
        permissionId: PERM,
        actions: ['read'],
      });

      expect(view).toMatchObject({ allActions: false, actions: ['read'] });
      const sql = query.mock.calls.map(([text]) => text);
      expect(
        sql.findIndex((s) => s.includes('DELETE FROM grant_actions')),
      ).toBeLessThan(sql.findIndex((s) => s.includes('UPDATE grants')));
    });

    it('answers a replace of a missing grant with 404', async () => {
      const { service } = setup([[/SELECT id FROM grants WHERE id/, []]]);

      expect(
        await codeOf(() =>
          service.replaceGrant(USER, 'g1', {
            roleId: ROLE,
            permissionId: PERM,
          }),
        ),
      ).toBe('not_found');
    });
  });

  describe('user roles', () => {
    it('answers an unknown user with 404 on read and on replace', async () => {
      const { service } = setup([[/SELECT id FROM users/, []]]);

      expect(await codeOf(() => service.getUserRoles(USER))).toBe('not_found');
      expect(await codeOf(() => service.replaceUserRoles(USER, USER, []))).toBe(
        'not_found',
      );
    });

    it('answers an unknown role with 404', async () => {
      const { service } = setup([
        [/SELECT id FROM users/, [{ id: USER }]],
        [/count\(\*\)::int AS count FROM roles/, [{ count: 0 }]],
      ]);

      expect(
        await codeOf(() => service.replaceUserRoles(USER, USER, [ROLE])),
      ).toBe('not_found');
    });

    it('replaces the roles and returns them', async () => {
      const { service } = setup([
        [/SELECT id FROM users/, [{ id: USER }]],
        [/count\(\*\)::int AS count FROM roles/, [{ count: 1 }]],
        [/SELECT role_id FROM user_roles/, [{ role_id: ROLE }]],
      ]);

      expect(await service.replaceUserRoles(USER, USER, [ROLE])).toEqual({
        userId: USER,
        roleIds: [ROLE],
      });
      expect(await service.getUserRoles(USER)).toEqual({
        userId: USER,
        roleIds: [ROLE],
      });
    });
  });

  it('lists roles, permissions and grants as views', async () => {
    const { service } = setup([
      [/FROM roles ORDER BY name/, [roleRow]],
      [
        /FROM permissions p LEFT JOIN/,
        [{ ...roleRow, id: PERM, actions: ['read'] }],
      ],
      [
        /FROM grants g LEFT JOIN/,
        [
          {
            id: 'g1',
            role_id: ROLE,
            permission_id: PERM,
            all_actions: false,
            actions: ['read'],
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      ],
    ]);

    expect(await service.listRoles()).toHaveLength(1);
    expect((await service.listPermissions())[0].actions).toEqual(['read']);
    expect((await service.listGrants())[0]).toMatchObject({
      roleId: ROLE,
      allActions: false,
      actions: ['read'],
    });
  });
});

describe('RbacAdminController', () => {
  it('passes the actor and ids to the service', async () => {
    const admin = Object.fromEntries(
      [
        'listRoles',
        'createRole',
        'replaceRole',
        'deleteRole',
        'listPermissions',
        'createPermission',
        'replacePermission',
        'deletePermission',
        'listGrants',
        'createGrant',
        'replaceGrant',
        'deleteGrant',
        'getUserRoles',
        'replaceUserRoles',
      ].map((name) => [name, jest.fn().mockResolvedValue(name)]),
    ) as unknown as Record<string, jest.Mock>;
    const c = new RbacAdminController(admin as unknown as RbacAdminService);
    const role = { name: 'r', description: null };
    const permission = { ...role, actions: ['read'] };
    const grant = { roleId: ROLE, permissionId: PERM };

    await c.listRoles();
    await c.createRole(USER, role);
    await c.replaceRole(USER, ROLE, role);
    await c.deleteRole(USER, ROLE);
    await c.listPermissions();
    await c.createPermission(USER, permission);
    await c.replacePermission(USER, PERM, permission);
    await c.deletePermission(USER, PERM);
    await c.listGrants();
    await c.createGrant(USER, grant);
    await c.replaceGrant(USER, 'g1', grant);
    await c.deleteGrant(USER, 'g1');
    await c.getUserRoles(USER);
    await c.replaceUserRoles(USER, USER, { roleIds: [ROLE] });

    for (const mock of Object.values(admin)) {
      expect(mock).toHaveBeenCalledTimes(1);
    }
    expect(admin.replaceUserRoles).toHaveBeenCalledWith(USER, USER, [ROLE]);
  });
});

describe('currentUserId', () => {
  const context = (authUserId?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ authUserId }) }),
    }) as unknown as ExecutionContext;

  it('gives the id the access check set', () => {
    expect(currentUserId(undefined, context(USER))).toBe(USER);
  });

  it('fails closed with 503 when the chain did not run', () => {
    expect(() => currentUserId(undefined, context())).toThrow(AppException);
  });
});
