import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { timestampNow } from '../../../database/columns';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

/**
 * "Role R may do these actions of permission P." One grant per (role, permission) pair.
 * `all_actions = true` covers every current and future action of the permission and has no
 * `grant_actions` rows; `false` covers exactly the listed rows.
 */
@Entity('grants')
@Unique('uq_grants_role_permission', ['roleId', 'permissionId'])
// Target of grant_actions' composite foreign key, which pins an action row to its grant's own permission.
@Unique('uq_grants_id_permission', ['id', 'permissionId'])
@Index('idx_grants_permission', ['permissionId'])
export class Grant {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_grants' })
  id: string;

  // No cascade: deleting a role or permission that is still granted must fail (409 in spec 1.1).
  @Column({ name: 'role_id', type: 'uuid' })
  @ForeignKey(() => Role, { name: 'fk_grants_role' })
  roleId: string;

  @Column({ name: 'permission_id', type: 'uuid' })
  @ForeignKey(() => Permission, { name: 'fk_grants_permission' })
  permissionId: string;

  @Column({ name: 'all_actions', type: 'boolean' })
  allActions: boolean;

  @Column(timestampNow('created_at'))
  createdAt: Date;

  @Column(timestampNow('updated_at'))
  updatedAt: Date;
}
