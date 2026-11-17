import {
  PolicyInconsistency,
  type PolicyRows,
  PolicySnapshot,
} from './policy-snapshot';

/** Spec 1.1 §1.3.1 steps 4–6 and §1.3.6 step 4: the decision and the coherence check. */
const ROLE_USER = 'r-user';
const ROLE_ADMIN = 'r-admin';
const ROLE_EMPTY = 'r-empty';
const P_USERS = 'p-users';
const P_RBAC = 'p-rbac';

const rows = (overrides: Partial<PolicyRows> = {}): PolicyRows => ({
  version: '7',
  roles: [
    { id: ROLE_USER, name: 'user' },
    { id: ROLE_ADMIN, name: 'admin' },
    { id: ROLE_EMPTY, name: 'empty' },
  ],
  permissions: [
    { id: P_USERS, name: 'users' },
    { id: P_RBAC, name: 'rbac' },
  ],
  permissionActions: [
    { permission_id: P_USERS, action: 'read' },
    { permission_id: P_USERS, action: 'update' },
    { permission_id: P_USERS, action: 'list' },
    { permission_id: P_RBAC, action: 'manage' },
  ],
  grants: [
    {
      id: 'g1',
      role_id: ROLE_USER,
      permission_id: P_USERS,
      all_actions: false,
    },
    {
      id: 'g2',
      role_id: ROLE_ADMIN,
      permission_id: P_USERS,
      all_actions: true,
    },
    {
      id: 'g3',
      role_id: ROLE_ADMIN,
      permission_id: P_RBAC,
      all_actions: false,
    },
  ],
  grantActions: [
    { grant_id: 'g1', permission_id: P_USERS, action: 'read' },
    { grant_id: 'g1', permission_id: P_USERS, action: 'update' },
    { grant_id: 'g3', permission_id: P_RBAC, action: 'manage' },
  ],
  ...overrides,
});

describe('PolicySnapshot', () => {
  const snapshot = PolicySnapshot.build(rows());

  it('keeps the version it was built from', () => {
    expect(snapshot.version).toBe('7');
  });

  it('allows an action listed in a limited grant', () => {
    expect(snapshot.allows([ROLE_USER], 'users', 'read')).toBe('allowed');
  });

  it('refuses an action the limited grant does not list', () => {
    expect(snapshot.allows([ROLE_USER], 'users', 'list')).toBe('no_grant');
  });

  it('allows every action of the permission for an all-actions grant', () => {
    expect(snapshot.allows([ROLE_ADMIN], 'users', 'list')).toBe('allowed');
    expect(snapshot.allows([ROLE_ADMIN], 'users', 'update')).toBe('allowed');
  });

  it('includes an action added later in all-actions grants only', () => {
    const later = PolicySnapshot.build(
      rows({
        permissionActions: [
          ...rows().permissionActions,
          { permission_id: P_USERS, action: 'export' },
        ],
      }),
    );

    expect(later.allows([ROLE_ADMIN], 'users', 'export')).toBe('allowed');
    expect(later.allows([ROLE_USER], 'users', 'export')).toBe('no_grant');
  });

  it('merges roles: one role that allows is enough', () => {
    expect(snapshot.allows([ROLE_EMPTY, ROLE_USER], 'users', 'read')).toBe(
      'allowed',
    );
    expect(snapshot.allows([ROLE_USER, ROLE_ADMIN], 'rbac', 'manage')).toBe(
      'allowed',
    );
  });

  it('refuses a user with no roles, or with roles that grant nothing', () => {
    expect(snapshot.allows([], 'users', 'read')).toBe('no_grant');
    expect(snapshot.allows([ROLE_EMPTY], 'users', 'read')).toBe('no_grant');
  });

  it('ignores role ids the policy does not know', () => {
    expect(snapshot.allows(['r-gone'], 'users', 'read')).toBe('no_grant');
  });

  it('refuses a permission or an action that does not exist (deny by default)', () => {
    expect(snapshot.allows([ROLE_ADMIN], 'reports', 'read')).toBe(
      'unknown_permission',
    );
    expect(snapshot.allows([ROLE_ADMIN], 'users', 'destroy')).toBe(
      'unknown_action',
    );
  });

  it('does not let a grant on one permission cover another', () => {
    expect(snapshot.allows([ROLE_USER], 'rbac', 'manage')).toBe('no_grant');
  });

  it('builds an empty policy that refuses everything', () => {
    const empty = PolicySnapshot.build({
      version: '0',
      roles: [],
      permissions: [],
      permissionActions: [],
      grants: [],
      grantActions: [],
    });

    expect(empty.allows([], 'rbac', 'manage')).toBe('unknown_permission');
  });

  describe('coherence (a reload that fails keeps no snapshot)', () => {
    it.each<[string, Partial<PolicyRows>]>([
      [
        'an all-actions grant with listed actions',
        {
          grantActions: [
            ...rows().grantActions,
            { grant_id: 'g2', permission_id: P_USERS, action: 'read' },
          ],
        },
      ],
      [
        'a limited grant with no actions',
        {
          grantActions: rows().grantActions.filter((a) => a.grant_id !== 'g3'),
        },
      ],
      [
        'a grant to an unknown role',
        {
          grants: [
            ...rows().grants,
            {
              id: 'g9',
              role_id: 'r-gone',
              permission_id: P_USERS,
              all_actions: true,
            },
          ],
        },
      ],
      [
        'a grant of an unknown permission',
        {
          grants: [
            ...rows().grants,
            {
              id: 'g9',
              role_id: ROLE_EMPTY,
              permission_id: 'p-gone',
              all_actions: true,
            },
          ],
        },
      ],
      [
        'a listed action the permission does not have',
        {
          grantActions: [
            ...rows().grantActions,
            { grant_id: 'g1', permission_id: P_USERS, action: 'destroy' },
          ],
        },
      ],
      [
        'a listed action of another permission',
        {
          grantActions: [
            ...rows().grantActions,
            { grant_id: 'g1', permission_id: P_RBAC, action: 'manage' },
          ],
        },
      ],
      [
        'a listed action of an unknown grant',
        {
          grantActions: [
            ...rows().grantActions,
            { grant_id: 'g-gone', permission_id: P_USERS, action: 'read' },
          ],
        },
      ],
    ])('refuses %s', (_name, overrides) => {
      expect(() => PolicySnapshot.build(rows(overrides))).toThrow(
        PolicyInconsistency,
      );
    });
  });
});
