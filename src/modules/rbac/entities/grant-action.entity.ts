import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

import { Grant } from './grant.entity';
import { PermissionAction } from './permission-action.entity';

/**
 * The explicit action list of a limited grant.
 * `permission_id` is repeated here on purpose. With it, two composite foreign keys make the database
 * guarantee what spec 1.1 asks for: a listed action belongs to the grant's own permission, and an
 * action that some grant lists explicitly cannot be removed from the permission.
 */
@Entity('grant_actions')
@ForeignKey(() => Grant, ['grantId', 'permissionId'], ['id', 'permissionId'], {
  name: 'fk_grant_actions_grant',
  onDelete: 'CASCADE',
})
@ForeignKey(
  () => PermissionAction,
  ['permissionId', 'action'],
  ['permissionId', 'action'],
  { name: 'fk_grant_actions_permission_action' },
)
@Index('idx_grant_actions_permission_action', ['permissionId', 'action'])
export class GrantAction {
  @PrimaryColumn({
    name: 'grant_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_grant_actions',
  })
  grantId: string;

  @PrimaryColumn({
    type: 'text',
    primaryKeyConstraintName: 'pk_grant_actions',
  })
  action: string;

  @Column({ name: 'permission_id', type: 'uuid' })
  permissionId: string;
}
