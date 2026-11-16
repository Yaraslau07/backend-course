import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { timestampNow } from '../../../database/columns';
import { RBAC_NAME_PATTERN } from '../rbac.types';

@Entity('roles')
@Unique('uq_roles_name', ['name'])
@Check('ck_roles_name', `"name" ~ '${RBAC_NAME_PATTERN}'`)
// An empty description is stored as null, so '' never reaches the table.
@Check('ck_roles_description', `char_length("description") BETWEEN 1 AND 500`)
export class Role {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_roles' })
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
