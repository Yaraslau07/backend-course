import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

import { timestampNow } from '../../../database/columns';

export const RBAC_POLICY_STATE_ID = 1;

/**
 * A single row. `version` grows with every policy change, and each instance compares it with its
 * snapshot before an access check. `SELECT … FOR UPDATE` on this row is also the shared lock that
 * serializes everything touching the "at least one active rbac@manage holder" rule
 * (first in the lock order, see docs/invariants.md). The migration inserts the row.
 */
@Entity('rbac_policy_state')
@Check('ck_rbac_policy_state_single_row', `"id" = 1`)
@Check('ck_rbac_policy_state_version', `"version" >= 0`)
export class RbacPolicyState {
  @PrimaryColumn({
    type: 'smallint',
    default: RBAC_POLICY_STATE_ID,
    primaryKeyConstraintName: 'pk_rbac_policy_state',
  })
  id: number;

  /** bigint, so the driver returns a string. */
  @Column({ type: 'bigint', default: 0 })
  version: string;

  @Column(timestampNow('updated_at'))
  updatedAt: Date;
}
