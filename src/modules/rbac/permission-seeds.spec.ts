import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { RbacPermissionSeeds } from './permission-seeds';

const SEED = {
  permission: 'things',
  actions: ['use', 'use_any'],
  defaultRoleActions: ['use'],
};

function setup(state: { existing?: boolean; roles?: string[] }) {
  const sql = jest.fn((text: string, _params?: unknown[]): Promise<unknown> => {
    void _params;
    if (text.startsWith('SELECT id FROM permissions'))
      return Promise.resolve(state.existing ? [{ id: 'p' }] : []);
    if (text.startsWith('SELECT id, name FROM roles'))
      return Promise.resolve(
        (state.roles ?? []).map((name) => ({ id: `${name}-id`, name })),
      );
    if (text.startsWith('INSERT INTO permissions'))
      return Promise.resolve([{ id: 'perm' }]);
    if (text.startsWith('INSERT INTO grants') && text.includes('RETURNING'))
      return Promise.resolve([{ id: 'grant' }]);
    return Promise.resolve([]);
  });
  const db = {
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work({ query: sql } as unknown as EntityManager),
  } as unknown as DataSource;
  const seeds = new RbacPermissionSeeds(db);
  seeds.register(SEED);
  const ran = (fragment: string) =>
    sql.mock.calls.filter(([text]) => text.includes(fragment));
  return { seeds, sql, ran };
}

describe('RbacPermissionSeeds (spec 2.0 §1.1)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('creates the permission, grants the default actions to user and all to admin, under the policy lock', async () => {
    const s = setup({ roles: ['user', 'admin'] });
    expect(await s.seeds.applyAll()).toEqual({ things: 'created' });
    expect(s.sql.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(s.ran('INSERT INTO grant_actions')[0][1]).toEqual([
      'grant',
      'perm',
      ['use'],
    ]);
    expect(s.ran('all_actions) VALUES ($1, $2, true)')[0][1]).toEqual([
      'admin-id',
      'perm',
    ]);
    expect(s.ran('version = version + 1')).toHaveLength(1);
  });

  it('works without an admin role', async () => {
    const s = setup({ roles: ['user'] });
    expect(await s.seeds.applyAll()).toEqual({ things: 'created' });
    expect(s.ran('all_actions) VALUES ($1, $2, true)')).toHaveLength(0);
  });

  it('does nothing when the permission exists (no restored grants) or there is no user role', async () => {
    for (const state of [{ existing: true, roles: ['user'] }, { roles: [] }]) {
      const s = setup(state);
      expect(await s.seeds.applyAll()).toEqual({
        things: state.existing ? 'present' : 'no_default_role',
      });
      expect(s.ran('INSERT')).toHaveLength(0);
      expect(s.ran('version = version + 1')).toHaveLength(0);
    }
  });

  it('refuses a duplicate seed or default actions it does not declare', () => {
    const { seeds } = setup({});
    expect(() => seeds.register(SEED)).toThrow();
    expect(() =>
      seeds.register({
        permission: 'other',
        actions: ['a'],
        defaultRoleActions: ['b'],
      }),
    ).toThrow();
  });
});
