import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { timestamp, timestampNow } from '../../../database/columns';
import { User } from '../../users/entities/user.entity';
import {
  TRANSFORMATION_STATUSES,
  TRANSFORMATION_STORAGE_STATUSES,
  TRANSFORMATION_TYPES,
  type TransformationStatus,
  type TransformationStorageStatus,
  type TransformationType,
} from '../transformation.types';

/**
 * One finished transformation (spec 2.0 §1.3.3): safe metadata only. No content, file name,
 * temporary path, parsed data or library message. Written once the request names a registered
 * pair (D65); refusals before that have no row. Storage columns arrive with spec 2.4 (C19).
 */
@Entity('transformations')
@Index('idx_transformations_user_created_at_id', ['userId', 'createdAt', 'id'])
// Spec 2.3 §1.6: retention deletes old rows in small batches, across users.
@Index('idx_transformations_created_at', ['createdAt'])
@Check(
  'ck_transformations_formats',
  `"source_format" ~ '^[a-z0-9]{1,16}$' AND "target_format" ~ '^[a-z0-9]{1,16}$' AND "source_format" <> "target_format"`,
)
@Check(
  'ck_transformations_sizes',
  `"input_size" >= 0 AND ("output_size" IS NULL OR "output_size" >= 0) AND "duration_ms" >= 0`,
)
// A success has a result size and no error; an error has a safe code and no result.
@Check(
  'ck_transformations_outcome',
  `("status" = 'success' AND "error_code" IS NULL AND "output_size" IS NOT NULL)` +
    ` OR ("status" = 'error' AND "error_code" IS NOT NULL AND "output_size" IS NULL)`,
)
@Check(
  'ck_transformations_error_code',
  `"error_code" ~ '^[a-z][a-z0-9_]{0,63}$'`,
)
// Spec 2.4 §1.6: the worker's queue and the expiry sweep read these.
@Index('idx_transformations_storage_status_until', [
  'storageStatus',
  'storedFileUntil',
])
// The key is unique; only a saved result has one (an `error` keeps it so cleanup can try the object).
@Index('uq_transformations_stored_file_key', ['storedFileKey'], {
  unique: true,
  where: '"stored_file_key" IS NOT NULL',
})
@Check(
  'ck_transformations_storage',
  `("storage_status" = 'not_requested' AND "stored_file_key" IS NULL AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NULL)` +
    ` OR ("status" = 'success' AND (` +
    `("storage_status" = 'pending' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NOT NULL)` +
    ` OR ("storage_status" = 'available' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NOT NULL AND "storage_next_attempt_at" IS NULL)` +
    ` OR ("storage_status" = 'error' AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NULL)))`,
)
@Check(
  'ck_transformations_storage_attempts',
  `"storage_attempts" BETWEEN 0 AND 5`,
)
export class Transformation {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_transformations',
  })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @ForeignKey(() => User, { name: 'fk_transformations_user' })
  userId: string;

  @Column({
    type: 'enum',
    enum: TRANSFORMATION_TYPES,
    enumName: 'transformation_type',
  })
  type: TransformationType;

  @Column({ name: 'source_format', type: 'text' })
  sourceFormat: string;

  @Column({ name: 'target_format', type: 'text' })
  targetFormat: string;

  @Column({
    type: 'enum',
    enum: TRANSFORMATION_STATUSES,
    enumName: 'transformation_status',
  })
  status: TransformationStatus;

  /** Bytes. `bigint` comes back from pg as a string; the limits keep it far below 2^53. */
  @Column({ name: 'input_size', type: 'bigint' })
  inputSize: string;

  @Column({ name: 'output_size', type: 'bigint', nullable: true })
  outputSize: string | null;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs: number;

  @Column({ name: 'error_code', type: 'text', nullable: true })
  errorCode: string | null;

  @Column(timestampNow('created_at'))
  createdAt: Date;

  @Column({
    name: 'storage_status',
    type: 'enum',
    enum: TRANSFORMATION_STORAGE_STATUSES,
    enumName: 'transformation_storage_status',
    default: 'not_requested',
  })
  storageStatus: TransformationStorageStatus;

  /** 128 random bits as hex (D55): the object's key and the name of its temporary copy. Never logged or returned. */
  @Column({ name: 'stored_file_key', type: 'text', nullable: true })
  storedFileKey: string | null;

  /** When the stored object expires; set once it is `available`. */
  @Column(timestamp('stored_file_until', { nullable: true }))
  storedFileUntil: Date | null;

  /** Writes tried so far (at most 5 before `error`). */
  @Column({ name: 'storage_attempts', type: 'smallint', default: 0 })
  storageAttempts: number;

  /** When a `pending` row is next due (a backoff after a failed write). */
  @Column(timestamp('storage_next_attempt_at', { nullable: true }))
  storageNextAttemptAt: Date | null;
}
