import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { timestampNow } from '../../../database/columns';

import { RBAC_NAME_PATTERN } from '../rbac.types';

@Entity('permissions')
@Unique('uq_permissions_name', ['name'])
@Check('ck_permissions_name', `"name" ~ '${RBAC_NAME_PATTERN}'`)
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

  @Column(timestampNow('created_at'))
  createdAt: Date;

  @Column(timestampNow('updated_at'))
  updatedAt: Date;
}
