import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  type EraseResult,
  UserDataErasers,
} from '@/modules/erasure/user-data-erasers';
import { lockRbacPolicy } from '@/modules/rbac/rbac-invariant';

import type { DeletionJobStatus, UserStatus } from './users.types';

/** At most 5 automatic starts, 1 minute apart (spec 1.6 §1.3.5). */
export const DELETION_MAX_ATTEMPTS = 5;
export const DELETION_RETRY_SECONDS = 60;
const POLL_MS = 5000;

type Failure = Exclude<EraseResult, { result: 'succeeded' }>;

/** Where a job goes after an unsuccessful start (§1.3.5 steps 4–5). */
export function afterFailure(
  result: Failure,
  attempts: number,
): Extract<DeletionJobStatus, 'queued' | 'failed'> {
  return result.result === 'permanent_failure' ||
    attempts >= DELETION_MAX_ATTEMPTS
    ? 'failed'
    : 'queued';
}

interface Claimed {
  id: string;
  user_id: string;
  attempts: number;
}

const CHALLENGE_TABLES = [
  'registration_challenges',
  'login_challenges',
  'email_change_challenges',
  'deletion_challenges',
];

/**
 * The deletion worker (spec 1.6 §1.3.5, §1.3.6). Jobs are rows claimed with `FOR UPDATE SKIP
 * LOCKED` under a lease; there is no broker. A claim sets the lease and counts a start; the erasers
 * run outside any transaction; the final anonymization is one transaction in the lock order policy
 * → user → job. Every write after the claim is fenced by `attempts`, so a worker whose lease expired
 * and was re-claimed can't overwrite the newer run. Logs carry no ids (§1.5).
 */
@Injectable()
export class DeletionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DeletionWorker');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly erasers: UserDataErasers,
  ) {}

  onModuleInit(): void {
    // Tests drive `run()` themselves.
    if (this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        this.logger.warn(
          { category: 'database' },
          'deletion worker unavailable',
        ),
      );
    }, POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Claims and processes due jobs; returns how many were processed. */
  async run(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.failExhausted();
      let processed = 0;
      while (processed < limit) {
        const job = await this.claim();
        if (!job) break;
        await this.process(job);
        processed++;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  /** A job whose lease expired after its 5th start is not started a 6th time (ck_deletion_jobs_attempts). */
  private async failExhausted(): Promise<void> {
    const [rows] = await this.db.query<[unknown[], number]>(
      `UPDATE deletion_jobs
          SET status = 'failed', lease_until = NULL, next_attempt_at = NULL,
              last_error_code = 'attempts_exhausted', updated_at = clock_timestamp()
        WHERE attempts >= $1
          AND ((status = 'running' AND lease_until <= clock_timestamp()) OR status = 'queued')
    RETURNING id`,
      [DELETION_MAX_ATTEMPTS],
    );
    if (rows.length > 0)
      this.event('deletion_job_failed', {
        code: 'attempts_exhausted',
        count: String(rows.length),
      });
  }

  /** Step 1: a due `queued` job, or a `running` one whose lease expired, becomes ours. */
  private async claim(): Promise<Claimed | null> {
    const [rows] = await this.db.query<[Claimed[], number]>(
      `UPDATE deletion_jobs
          SET status = 'running', attempts = attempts + 1, next_attempt_at = NULL,
              lease_until = clock_timestamp() + make_interval(secs => $1),
              updated_at = clock_timestamp()
        WHERE id = (
          SELECT id FROM deletion_jobs
           WHERE attempts < $2
             AND ((status = 'queued' AND next_attempt_at <= clock_timestamp())
               OR (status = 'running' AND lease_until <= clock_timestamp()))
           ORDER BY coalesce(next_attempt_at, lease_until), id
           LIMIT 1
             FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, attempts`,
      [this.config.get('DELETION_WORKER_LEASE_SECONDS'), DELETION_MAX_ATTEMPTS],
    );
    const job = rows[0];
    if (job)
      this.event('deletion_job_claimed', { attempt: String(job.attempts) });
    return job ?? null;
  }

  private async process(job: Claimed): Promise<void> {
    let outcome: EraseResult = await this.erasers.eraseAll(job.user_id, job.id);
    if (outcome.result === 'succeeded') {
      let finished: Awaited<ReturnType<DeletionWorker['finalize']>>;
      try {
        finished = await this.finalize(job);
      } catch {
        // Step 6: a final transaction that doesn't commit is a retryable failure.
        finished = { result: 'retryable_failure', code: 'finalize_failed' };
      }
      if (finished === 'done') return;
      if (finished === 'lost') {
        this.event('deletion_job_lease_lost', { stage: 'finalize' });
        return;
      }
      outcome = finished;
    }
    await this.fail(job, outcome);
  }

  /** §1.3.6: the one anonymizing transaction. `lost`: another run owns the job now. */
  private finalize(job: Claimed): Promise<'done' | 'lost' | Failure> {
    return this.db.transaction(async (manager) => {
      await lockRbacPolicy(manager);
      const [user] = await manager.query<
        { status: UserStatus; photo_key: string | null }[]
      >(`SELECT status, photo_key FROM users WHERE id = $1 FOR UPDATE`, [
        job.user_id,
      ]);
      const [current] = await manager.query<
        {
          status: DeletionJobStatus;
          attempts: number;
          tombstone_email: string;
        }[]
      >(
        `SELECT status, attempts, tombstone_email FROM deletion_jobs WHERE id = $1 FOR UPDATE`,
        [job.id],
      );
      if (current?.status === 'succeeded' && user?.status === 'deleted')
        return 'done';
      if (
        current?.status !== 'running' ||
        current.attempts !== job.attempts ||
        user?.status !== 'deleting'
      )
        return 'lost';
      // Step 2: the profile eraser must have removed the photo.
      if (user.photo_key)
        return { result: 'retryable_failure', code: 'photo_remaining' };

      for (const table of CHALLENGE_TABLES)
        await manager.query(`DELETE FROM ${table} WHERE user_id = $1`, [
          job.user_id,
        ]);
      const [, removed] = await manager.query<[unknown[], number]>(
        `DELETE FROM user_roles WHERE user_id = $1`,
        [job.user_id],
      );
      if (removed > 0)
        await manager.query(
          `UPDATE rbac_policy_state SET version = version + 1, updated_at = clock_timestamp() WHERE id = 1`,
        );
      await manager.query(
        `UPDATE users
            SET email = $2, display_name = NULL, photo_key = NULL, password_hash = NULL,
                status = 'deleted', updated_at = clock_timestamp()
          WHERE id = $1`,
        [job.user_id, current.tombstone_email],
      );
      await manager.query(
        `UPDATE deletion_jobs
            SET status = 'succeeded', finished_at = clock_timestamp(), lease_until = NULL,
                next_attempt_at = NULL, last_error_code = NULL, updated_at = clock_timestamp()
          WHERE id = $1`,
        [job.id],
      );
      this.event('user_deleted', { result: 'anonymized' });
      this.event('deletion_job_succeeded', { attempt: String(job.attempts) });
      return 'done';
    });
  }

  /** Steps 4–5, fenced by the claimed attempt so an expired lease can't overwrite a newer run. */
  private async fail(job: Claimed, outcome: Failure): Promise<void> {
    const next = afterFailure(outcome, job.attempts);
    const [, updated] = await this.db.query<[unknown[], number]>(
      `UPDATE deletion_jobs
          SET status = $2::deletion_job_status, lease_until = NULL, last_error_code = $3,
              next_attempt_at = CASE WHEN $2 = 'queued'
                                     THEN clock_timestamp() + make_interval(secs => $5) END,
              updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'running' AND attempts = $4`,
      [job.id, next, outcome.code, job.attempts, DELETION_RETRY_SECONDS],
    );
    if (updated === 0) {
      this.event('deletion_job_lease_lost', { stage: 'failure' });
      return;
    }
    this.event(
      next === 'queued' ? 'deletion_job_retry' : 'deletion_job_failed',
      {
        code: outcome.code,
        attempt: String(job.attempts),
      },
    );
  }

  private event(event: string, fields: Record<string, string>): void {
    this.logger.log({ event, ...fields }, 'deletion job event');
  }
}
