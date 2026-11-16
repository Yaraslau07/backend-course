import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Same pattern for role names, permission names and actions (spec 1.1). Applied after trim + lowercase. */
export const RBAC_NAME_SQL_PATTERN = '^[a-z][a-z0-9._-]{0,63}$';

@Entity('roles')
@Unique('uq_roles_name', ['name'])
@Check('ck_roles_name', `"name" ~ '${RBAC_NAME_SQL_PATTERN}'`)
// An empty description is stored as null, so '' never reaches the table.
@Check('ck_roles_description', `char_length("description") BETWEEN 1 AND 500`)
export class Role {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_roles' })
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
