import { Check, Entity, ForeignKey, PrimaryColumn } from 'typeorm';

import { RBAC_NAME_PATTERN } from '../rbac.types';
import { Permission } from './permission.entity';

/** The valid actions of one permission, for example `users` → `read`, `read_any`, … */
@Entity('permission_actions')
@Check('ck_permission_actions_action', `"action" ~ '${RBAC_NAME_PATTERN}'`)
export class PermissionAction {
  // Deleting a permission takes its actions with it; a permission that is still granted can't be deleted at all.
  @PrimaryColumn({
    name: 'permission_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_permission_actions',
  })
  @ForeignKey(() => Permission, {
    name: 'fk_permission_actions_permission',
    onDelete: 'CASCADE',
  })
  permissionId: string;

  @PrimaryColumn({
    type: 'text',
    primaryKeyConstraintName: 'pk_permission_actions',
  })
  action: string;
}
