import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { RBAC_NAME_SQL_PATTERN } from './role.entity';

@Entity('permissions')
@Unique('uq_permissions_name', ['name'])
@Check('ck_permissions_name', `"name" ~ '${RBAC_NAME_SQL_PATTERN}'`)
@Check(
  'ck_permissions_description',
  `char_length("description") BETWEEN 1 AND 500`,
)
export class Permission {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_permissions',
  })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    precision: 3,
    default: () => 'now()',
  })
  createdAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    precision: 3,
    default: () => 'now()',
  })
  updatedAt: Date;
}
