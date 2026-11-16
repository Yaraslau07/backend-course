import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

import { timestampNow } from '../../../database/columns';

import { User } from '../../users/entities/user.entity';

import { Role } from './role.entity';

@Entity('user_roles')
// The primary key serves "roles of a user"; this one serves "is this role assigned to anyone".
@Index('idx_user_roles_role', ['roleId'])
export class UserRole {
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_roles',
  })
  @ForeignKey(() => User, { name: 'fk_user_roles_user' })
  userId: string;

  // No cascade: a role with assigned users can't be deleted (409 in spec 1.1).
  @PrimaryColumn({
    name: 'role_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_roles',
  })
  @ForeignKey(() => Role, { name: 'fk_user_roles_role' })
  roleId: string;

  @Column(timestampNow('created_at'))
  createdAt: Date;
}
