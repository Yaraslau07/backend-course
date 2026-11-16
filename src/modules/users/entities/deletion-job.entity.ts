import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

import { DELETION_JOB_STATUSES, type DeletionJobStatus } from '../users.types';
import { User } from './user.entity';

/**
 * One durable deletion job per user (spec 1.6). The id is the client's `Idempotency-Key`,
 * so a client that lost the 202 response already knows its receipt.
 * The worker claims rows through `idx_deletion_jobs_claim`; there is no external broker.
 */
@Entity('deletion_jobs')
@Unique('uq_deletion_jobs_user', ['userId'])
@Unique('uq_deletion_jobs_tombstone_email', ['tombstoneEmail'])
@Index('idx_deletion_jobs_claim', ['status', 'nextAttemptAt', 'leaseUntil'])
@Check('ck_deletion_jobs_id', `"id" ~ '^[0-9a-f]{32}$'`)
@Check(
  'ck_deletion_jobs_tombstone_email',
  `"tombstone_email" ~ '^deleted\\.[0-9a-f]{32}@example\\.invalid$'`,
)
@Check('ck_deletion_jobs_attempts', `"attempts" BETWEEN 0 AND 5`)
// Each status fixes which of lease / next attempt / finish time is set, so a half-updated job can't be stored.
@Check(
  'ck_deletion_jobs_state',
  `("status" = 'queued' AND "next_attempt_at" IS NOT NULL AND "lease_until" IS NULL AND "finished_at" IS NULL)` +
    ` OR ("status" = 'running' AND "lease_until" IS NOT NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NULL)` +
    ` OR ("status" = 'failed' AND "lease_until" IS NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NULL)` +
    ` OR ("status" = 'succeeded' AND "lease_until" IS NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NOT NULL)`,
)
export class DeletionJob {
  /** 32 lowercase hex characters chosen by the client. */
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'pk_deletion_jobs' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @ForeignKey(() => User, { name: 'fk_deletion_jobs_user' })
  userId: string;

  @Column({
    type: 'enum',
    enum: DELETION_JOB_STATUSES,
    enumName: 'deletion_job_status',
  })
  status: DeletionJobStatus;

  /** Automatic starts so far (at most 5). An admin retry of a failed job resets it. */
  @Column({ type: 'smallint', default: 0 })
  attempts: number;

  @Column({
    name: 'lease_until',
    type: 'timestamptz',
    precision: 3,
    nullable: true,
  })
  leaseUntil: Date | null;

  @Column({
    name: 'next_attempt_at',
    type: 'timestamptz',
    precision: 3,
    nullable: true,
  })
  nextAttemptAt: Date | null;

  /** Generated once when the job is created; becomes the user's email at anonymization. */
  @Column({ name: 'tombstone_email', type: 'text' })
  tombstoneEmail: string;

  /** A safe code from an eraser, never a library message. */
  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode: string | null;

  @Column({
    name: 'finished_at',
    type: 'timestamptz',
    precision: 3,
    nullable: true,
  })
  finishedAt: Date | null;

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
