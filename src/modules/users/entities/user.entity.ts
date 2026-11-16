import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { USER_STATUSES, type UserStatus } from '../users.types';

/**
 * The row is never physically deleted: deletion anonymizes it (tombstone email, nulls, `deleted`),
 * so foreign keys elsewhere keep pointing at something (spec 1.6, section 1.3.6).
 *
 * Timestamps are `timestamptz(3)`: a JS Date holds milliseconds, so a value read from the
 * database and put into a list cursor compares equal to the stored one (see D12).
 * `updated_at` has no trigger and no auto-update: a no-op PATCH must leave it untouched (spec 1.5),
 * so every write sets it explicitly with `now()`.
 */
@Entity('users')
@Unique('uq_users_email', ['email'])
// The app normalizes (trim, lowercase) before writing; the database only refuses what is certainly wrong.
@Check(
  'ck_users_email',
  `"email" = btrim("email") AND char_length("email") BETWEEN 3 AND 254`,
)
@Check('ck_users_display_name', `char_length("display_name") BETWEEN 1 AND 80`)
// Spec 1.6: password_hash may be null only when deleted, and a deleted row carries no name or photo.
@Check(
  'ck_users_deleted_state',
  `("status" = 'deleted' AND "password_hash" IS NULL AND "display_name" IS NULL AND "photo_key" IS NULL)` +
    ` OR ("status" <> 'deleted' AND "password_hash" IS NOT NULL)`,
)
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_users' })
  id: string;

  /** Normalized: trimmed and lowercased. After deletion, a random tombstone address. */
  @Column({ type: 'text' })
  email: string;

  /** The argon2 encoded string (salt and parameters included). */
  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName: string | null;

  /** Opaque storage key; never leaves the server. */
  @Column({ name: 'photo_key', type: 'text', nullable: true })
  photoKey: string | null;

  @Column({ type: 'enum', enum: USER_STATUSES, enumName: 'user_status' })
  status: UserStatus;

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
