import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { timestampNow } from '../../../database/columns';

import {
  STORAGE_CLEANUP_REASONS,
  STORAGE_CLEANUP_STATUSES,
  type StorageCleanupReason,
  type StorageCleanupStatus,
} from '../storage.types';

/**
 * "Delete this object from storage", written in the same transaction that drops the reference
 * (spec 1.5), so a storage outage can't leave an object behind. The worker retries up to 5 times,
 * 1 minute apart; `not_found` counts as success.
 */
@Entity('storage_cleanup_jobs')
@Index('idx_storage_cleanup_jobs_claim', ['status', 'nextAttemptAt'])
@Check('ck_storage_cleanup_jobs_attempts', `"attempts" BETWEEN 0 AND 5`)
@Check(
  'ck_storage_cleanup_jobs_state',
  `("status" = 'queued') = ("next_attempt_at" IS NOT NULL)`,
)
export class StorageCleanupJob {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_storage_cleanup_jobs',
  })
  id: string;

  /** The object to delete. Never logged; logs carry the job id instead. */
  @Column({ name: 'storage_key', type: 'text' })
  storageKey: string;

  @Column({
    type: 'enum',
    enum: STORAGE_CLEANUP_REASONS,
    enumName: 'storage_cleanup_reason',
  })
  reason: StorageCleanupReason;

  @Column({
    type: 'enum',
    enum: STORAGE_CLEANUP_STATUSES,
    enumName: 'storage_cleanup_status',
    default: 'queued',
  })
  status: StorageCleanupStatus;

  @Column({ type: 'smallint', default: 0 })
  attempts: number;

  @Column(timestampNow('next_attempt_at', { nullable: true }))
  nextAttemptAt: Date | null;

  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode: string | null;

  @Column(timestampNow('created_at'))
  createdAt: Date;

  @Column(timestampNow('updated_at'))
  updatedAt: Date;
}
