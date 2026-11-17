/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */

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

/**
 * An immutable, in-memory view of the policy at one version: which actions of which permission each
 * role may do. User roles are not part of it; they are read per request (D45).
 */
export class PolicySnapshot {
  private constructor(readonly version: string) {}

  static build(_rows: PolicyRows): PolicySnapshot {
    throw new Error('not implemented');
  }

  allows(
    _roleIds: readonly string[],
    _permission: string,
    _action: string,
  ): Decision {
    throw new Error('not implemented');
  }
}
