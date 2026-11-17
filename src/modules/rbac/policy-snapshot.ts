/** The RBAC tables as read in one consistent transaction (spec 1.1 §1.3.6). */
export interface PolicyRows {
  /** `rbac_policy_state.version`; bigint, so a string. */
  version: string;
  roles: { id: string; name: string }[];
  permissions: { id: string; name: string }[];
  permissionActions: { permission_id: string; action: string }[];
  grants: {
    id: string;
    role_id: string;
    permission_id: string;
    all_actions: boolean;
  }[];
  grantActions: { grant_id: string; permission_id: string; action: string }[];
}

/** Why the snapshot allowed or refused; only the log sees it. */
export type Decision =
  | 'allowed'
  | 'no_grant'
  | 'unknown_permission'
  | 'unknown_action';

/** Thrown by `build()` when the rows don't form a coherent policy; the snapshot is not replaced. */
export class PolicyInconsistency extends Error {
  constructor(readonly reason: string) {
    super(`RBAC policy is inconsistent: ${reason}`);
    this.name = 'PolicyInconsistency';
  }
}

/** What one role may do with one permission: everything, or the listed actions. */
type Coverage = { all: true } | { all: false; actions: ReadonlySet<string> };

/**
 * An immutable, in-memory view of the policy at one version: which actions of which permission each
 * role may do. User roles are not part of it; they are read per request (D45).
 */
export class PolicySnapshot {
  private constructor(
    readonly version: string,
    /** permission name → its valid actions */
    private readonly actions: ReadonlyMap<string, ReadonlySet<string>>,
    /** role id → permission name → coverage */
    private readonly grants: ReadonlyMap<string, ReadonlyMap<string, Coverage>>,
  ) {}

  /**
   * Builds the snapshot and checks what the schema can't express on its own (spec 1.1 §1.3.6
   * step 4, "check the connections"): an all-actions grant lists nothing, a limited grant lists
   * at least one action, and every reference points at a row of this same read.
   */
  static build(rows: PolicyRows): PolicySnapshot {
    const roleIds = new Set(rows.roles.map((role) => role.id));
    const permissionNames = new Map(
      rows.permissions.map((p) => [p.id, p.name]),
    );

    const actions = new Map<string, Set<string>>();
    for (const permission of rows.permissions) {
      actions.set(permission.name, new Set());
    }
    for (const { permission_id, action } of rows.permissionActions) {
      const name = permissionNames.get(permission_id);
      if (name === undefined) {
        throw new PolicyInconsistency('action of an unknown permission');
      }
      actions.get(name)!.add(action);
    }

    const listed = new Map<string, Set<string>>();
    for (const row of rows.grantActions) listed.set(row.grant_id, new Set());
    const grantsById = new Map(rows.grants.map((grant) => [grant.id, grant]));
    for (const row of rows.grantActions) {
      const grant = grantsById.get(row.grant_id);
      if (!grant) throw new PolicyInconsistency('action of an unknown grant');
      if (grant.permission_id !== row.permission_id) {
        throw new PolicyInconsistency(
          'grant lists an action of another permission',
        );
      }
      const name = permissionNames.get(row.permission_id);
      if (name === undefined || !actions.get(name)!.has(row.action)) {
        throw new PolicyInconsistency(
          'grant lists an action the permission lacks',
        );
      }
      listed.get(row.grant_id)!.add(row.action);
    }

    const grants = new Map<string, Map<string, Coverage>>();
    for (const grant of rows.grants) {
      if (!roleIds.has(grant.role_id)) {
        throw new PolicyInconsistency('grant to an unknown role');
      }
      const name = permissionNames.get(grant.permission_id);
      if (name === undefined) {
        throw new PolicyInconsistency('grant of an unknown permission');
      }
      const own = listed.get(grant.id);
      if (grant.all_actions && own) {
        throw new PolicyInconsistency('all-actions grant lists actions');
      }
      if (!grant.all_actions && !own) {
        throw new PolicyInconsistency('limited grant lists no action');
      }
      const byPermission =
        grants.get(grant.role_id) ?? new Map<string, Coverage>();
      byPermission.set(
        name,
        grant.all_actions ? { all: true } : { all: false, actions: own! },
      );
      grants.set(grant.role_id, byPermission);
    }

    return new PolicySnapshot(rows.version, actions, grants);
  }

  /**
   * Spec 1.1 §1.3.1 steps 4–6: allowed if any of the roles has a grant on the permission that
   * covers all actions or lists this one. A permission or action the policy doesn't know is
   * refused (no rule means no access).
   */
  allows(
    roleIds: readonly string[],
    permission: string,
    action: string,
  ): Decision {
    const valid = this.actions.get(permission);
    if (!valid) return 'unknown_permission';
    if (!valid.has(action)) return 'unknown_action';
    for (const roleId of roleIds) {
      const coverage = this.grants.get(roleId)?.get(permission);
      if (coverage && (coverage.all || coverage.actions.has(action))) {
        return 'allowed';
      }
    }
    return 'no_grant';
  }
}
