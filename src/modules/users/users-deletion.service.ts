import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { FastifyRequest } from 'fastify';
import { DataSource, type EntityManager } from 'typeorm';

import {
  IdempotentReplays,
  type ReplayVerdict,
} from '@/core/authorization/idempotent-replay';
import { Ownership } from '@/core/authorization/ownership';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import {
  ChallengeEngine,
  ChallengeRejected,
  type IssuedChallenge,
  type Outcome,
} from '@/modules/challenges/challenge-engine.service';
import { isChallengeId } from '@/modules/challenges/challenge-secrets';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';
import {
  assertRbacManagerRemains,
  lockRbacPolicy,
} from '@/modules/rbac/rbac-invariant';

import { idempotencyKey, newTombstone, receiptJobId } from './deletion-input';
import { challengeInput } from './update-input';
import { validateUserId } from './user-list-query';
import type { DeletionJobStatus, UserStatus } from './users.types';

/** The 202 answer of every accepted (or replayed) deletion (spec 1.6 §1.3.2, §1.3.3). */
export interface DeletionReceipt {
  jobId: string;
  status: DeletionJobStatus;
  statusUrl: string;
}

/** The status answer (spec 1.6 §1.3.4). `finishedAt` is set only for `succeeded`. */
export interface DeletionStatus {
  jobId: string;
  status: DeletionJobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  user_id: string;
  status: DeletionJobStatus;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}
interface UserRow {
  id: string;
  email: string;
  status: UserStatus;
}

const JOB_FIELDS = 'id, user_id, status, created_at, updated_at, finished_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A valid non-UUID id is an absent target, bound as null rather than cast (D51). */
const uuid = (id: string) => (UUID.test(id) ? id : null);
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Challenges a deletion makes obsolete. Its own deletion challenge is handled separately. */
const OTHER_SCENARIOS = ['registration', 'login', 'email_change'] as const;

/**
 * Accepting a deletion (spec 1.6): the self challenge, the self confirmation, the admin DELETE and
 * the status endpoint. Acceptance is one transaction (policy → user → challenge → job): the job and
 * tombstone, `deleting`, no roles, a new RBAC version, the challenges consumed. `DeletionWorker`
 * erases and anonymizes later. Logs carry no ids, keys, emails or tombstones (§1.5).
 */
@Injectable()
export class UsersDeletionService implements OnModuleInit {
  private readonly logger = new Logger('UsersDeletion');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly ownership: Ownership,
    private readonly authorizer: RbacAuthorizer,
    private readonly challenges: ChallengeEngine,
    private readonly limiter: RateLimiter,
    private readonly replays: IdempotentReplays,
  ) {}

  onModuleInit(): void {
    this.replays.register('deletion_confirm', (request) =>
      this.matchReplay(request),
    );
  }

  /* ---------- self challenge (§1.3.1) ---------- */

  async startChallenge(
    actor: string,
    target: string,
  ): Promise<Record<string, unknown>> {
    this.self(actor, target, 'UsersDeletion.challenge');
    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<Delivery>> => {
        const row = await this.lockUser(manager, actor);
        // Lock order: user → outstanding challenge → job (step 3).
        await manager.query(
          `SELECT id FROM deletion_challenges WHERE user_id = $1 AND consumed_at IS NULL FOR UPDATE`,
          [row.id],
        );
        await this.refuseIfJob(manager, row.id);
        if (row.status !== 'active') return this.inactive(manager, row.id);
        const issued = await this.challenges.issue(manager, 'deletion', {
          userId: row.id,
          method: this.config.get('DELETION_CONFIRMATION_METHOD'),
        });
        if (!issued.ok) return issued;
        await this.emailBudget(manager, row.id);
        return {
          ok: true,
          value: { issued: issued.value, address: row.email },
        };
      },
    );
    return this.deliver(outcome);
  }

  async resendChallenge(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    this.self(actor, target, 'UsersDeletion.resend');
    const input = challengeInput(raw, true, 'deletion');
    if (!('challengeId' in input)) throw new AppException('bad_request');
    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<Delivery>> => {
        const row = await this.lockUser(manager, actor);
        if (isChallengeId(input.challengeId))
          await manager.query(
            `SELECT id FROM deletion_challenges WHERE id = $1 FOR UPDATE`,
            [input.challengeId],
          );
        await this.refuseIfJob(manager, row.id);
        if (row.status !== 'active') return this.inactive(manager, row.id);
        const issued = await this.challenges.resend(manager, 'deletion', {
          userId: row.id,
          challengeId: input.challengeId,
          userEligible: true,
        });
        if (!issued.ok) return issued;
        await this.emailBudget(manager, row.id);
        return {
          ok: true,
          value: { issued: issued.value, address: row.email },
        };
      },
    );
    return this.deliver(outcome);
  }

  /* ---------- self confirmation (§1.3.2) ---------- */

  /**
   * The guard's `@Replay` matcher: before any session check, a key already accepted for the path's
   * user is a replay, and a key of another user's job is a conflict.
   */
  async matchReplay(request: FastifyRequest): Promise<ReplayVerdict> {
    const key = receiptJobId(request.headers['idempotency-key']);
    const target = (request.params as { userId?: unknown } | undefined)?.userId;
    if (!key || typeof target !== 'string') return 'none';
    const existing = await this.jobById(this.db.manager, key);
    if (!existing) return 'none';
    if (sameId(existing.user_id, target)) return 'replay';
    this.event('deletion_key_conflict', { mode: 'self' });
    return 'conflict';
  }

  async confirm(
    actor: string | undefined,
    target: string,
    rawKey: unknown,
    raw: unknown,
  ): Promise<DeletionReceipt> {
    validateUserId(target);
    const key = idempotencyKey(rawKey);
    const input = challengeInput(raw, false, 'deletion');
    // Step 2: an idempotent retry answers with the job, without looking at the challenge.
    const existing = await this.jobById(this.db.manager, key);
    if (existing) return this.replayOrConflict(existing, target, 'self');
    // Not a replay, so the guard ran the full chain; without its user the request fails closed.
    if (!actor) throw new AppException('authorization_unavailable');
    this.self(actor, target, 'UsersDeletion.confirm');

    let outcome: Outcome<{ receipt: DeletionReceipt; accepted: boolean }>;
    try {
      outcome = await this.db.transaction(async (manager) => {
        await lockRbacPolicy(manager);
        const row = await this.lockUser(manager, actor);
        const checked = await this.challenges.confirm(manager, 'deletion', {
          userId: row.id,
          // Step 6: a user who is no longer active consumes the challenge as user_inactive.
          userEligible: row.status === 'active',
          ...('token' in input
            ? { token: input.token }
            : { challengeId: input.challengeId, code: input.code! }),
        });
        if (!checked.ok) return checked;
        const current = await this.jobForUser(manager, row.id, true);
        if (current) {
          // Step 8: a job under another key already exists; it is the answer.
          await this.challenges.claim(
            manager,
            'deletion',
            checked.value.id,
            'job_exists',
          );
          return {
            ok: true,
            value: { receipt: this.receipt(current), accepted: false },
          };
        }
        if (
          !(await this.challenges.claim(
            manager,
            'deletion',
            checked.value.id,
            'confirmed',
          ))
        )
          return {
            ok: false,
            error: new ChallengeRejected('invalid_challenge', 'claimed'),
          };
        return {
          ok: true,
          value: {
            receipt: await this.accept(manager, row, key),
            accepted: true,
          },
        };
      });
    } catch (error) {
      throw this.acceptanceError(error, 'self');
    }

    if (!outcome.ok) {
      const { reason } = outcome.error;
      this.event('deletion_confirm_refused', { mode: 'self', reason });
      if (reason === 'user_inactive') throw new AppException('invalid_session');
      if (reason === 'consumed:job_exists') {
        const current = await this.jobForUser(this.db.manager, actor);
        if (current) return this.receipt(current);
      }
      throw outcome.error;
    }
    this.event(
      outcome.value.accepted ? 'deletion_accepted' : 'deletion_replay',
      {
        mode: 'self',
      },
    );
    return outcome.value.receipt;
  }

  /* ---------- admin deletion (§1.3.3) ---------- */

  async adminDelete(
    actor: string,
    target: string,
    rawKey: unknown,
  ): Promise<DeletionReceipt> {
    validateUserId(target);
    const key = idempotencyKey(rawKey);
    if (sameId(actor, target)) {
      this.event('deletion_refused', {
        mode: 'admin',
        reason: 'self_confirmation_required',
      });
      throw new AppException('self_confirmation_required');
    }
    // Before any lookup, so a client without the right never learns whether the target exists.
    await this.authorizer.authorize(
      actor,
      'users',
      'delete_any',
      'UsersDeletion.adminDelete',
    );
    const byKey = await this.jobById(this.db.manager, key);
    if (byKey && !sameId(byKey.user_id, target))
      return this.replayOrConflict(byKey, target, 'admin');

    try {
      return await this.db.transaction(async (manager) => {
        await lockRbacPolicy(manager);
        const rows = await manager.query<UserRow[]>(
          `SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE`,
          [uuid(target)],
        );
        const row = rows[0];
        if (!row) throw new AppException('not_found');
        const existing = await this.jobForUser(manager, row.id, true);
        if (existing) return this.existingForAdmin(manager, existing);
        if (row.status === 'deleting' || row.status === 'deleted') {
          this.logger.error(
            {
              event: 'deletion_consistency_violation',
              status: row.status,
              category: 'job_missing',
            },
            'user is being deleted but has no deletion job',
          );
          throw new AppException('service_unavailable');
        }
        const receipt = await this.accept(manager, row, key);
        this.event('deletion_accepted', { mode: 'admin' });
        return receipt;
      });
    } catch (error) {
      throw this.acceptanceError(error, 'admin');
    }
  }

  /* ---------- status (§1.3.4) ---------- */

  /**
   * Without a verified user the guard took the receipt branch (the header was present): the self
   * branch, where the receipt alone decides. Otherwise the admin branch.
   */
  async status(
    actor: string | undefined,
    target: string,
    rawReceipt: unknown,
  ): Promise<DeletionStatus> {
    if (!actor) {
      const jobId = receiptJobId(rawReceipt);
      const found = jobId ? await this.jobById(this.db.manager, jobId) : null;
      // The receipt must name exactly this path's user; anything else is the same 404.
      const ok = found !== null && found.user_id === target;
      this.event('deletion_status', {
        branch: 'self',
        result: ok ? 'found' : 'not_found',
      });
      if (!ok) throw new AppException('not_found');
      return this.statusView(found);
    }
    if (sameId(actor, target)) {
      this.event('deletion_status', { branch: 'admin', result: 'self' });
      throw new AppException('forbidden');
    }
    await this.authorizer.authorize(
      actor,
      'users',
      'delete_any',
      'UsersDeletion.status',
    );
    validateUserId(target);
    const found = await this.jobForUser(this.db.manager, uuid(target));
    this.event('deletion_status', {
      branch: 'admin',
      result: found ? 'found' : 'not_found',
    });
    if (!found) throw new AppException('not_found');
    return this.statusView(found);
  }

  /* ---------- internals ---------- */

  /**
   * Steps 10–11 (self) and 9, 11 (admin), in the caller's transaction after the policy and user
   * locks: the job and its one tombstone, `deleting`, the user's roles removed (then the last
   * `rbac@manage` check, which rolls everything back with 409), a new RBAC version, and every
   * outstanding challenge consumed.
   */
  private async accept(
    manager: EntityManager,
    row: UserRow,
    key: string,
  ): Promise<DeletionReceipt> {
    const [created] = await manager.query<JobRow[]>(
      `INSERT INTO deletion_jobs (id, user_id, status, attempts, next_attempt_at, tombstone_email)
       VALUES ($1, $2, 'queued', 0, clock_timestamp(), $3) RETURNING ${JOB_FIELDS}`,
      [key, row.id, newTombstone()],
    );
    await manager.query(
      `UPDATE users SET status = 'deleting', updated_at = clock_timestamp() WHERE id = $1`,
      [row.id],
    );
    await manager.query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id]);
    await assertRbacManagerRemains(manager);
    await manager.query(
      `UPDATE rbac_policy_state SET version = version + 1, updated_at = clock_timestamp() WHERE id = 1`,
    );
    for (const scenario of OTHER_SCENARIOS)
      await this.challenges.consumeOutstanding(
        manager,
        scenario,
        row.id,
        'user_inactive',
      );
    // A self deletion has already claimed its challenge as `confirmed`; an admin one supersedes it.
    await this.challenges.consumeOutstanding(
      manager,
      'deletion',
      row.id,
      'job_exists',
    );
    this.event('user_deleting', { from: row.status });
    return this.receipt(created);
  }

  /** Step 7: an existing job is the answer; a failed one goes back to the queue (same tombstone). */
  private async existingForAdmin(
    manager: EntityManager,
    existing: JobRow,
  ): Promise<DeletionReceipt> {
    if (existing.status !== 'failed') {
      this.event('deletion_replay', { mode: 'admin' });
      return this.receipt(existing);
    }
    const [requeued] = await manager.query<[JobRow[], number]>(
      `UPDATE deletion_jobs
          SET status = 'queued', attempts = 0, next_attempt_at = clock_timestamp(),
              lease_until = NULL, last_error_code = NULL, updated_at = clock_timestamp()
        WHERE id = $1 RETURNING ${JOB_FIELDS}`,
      [existing.id],
    );
    this.event('deletion_admin_retry', { result: 'queued' });
    return this.receipt(requeued[0]);
  }

  private replayOrConflict(
    existing: JobRow,
    target: string,
    mode: 'self' | 'admin',
  ): DeletionReceipt {
    if (!sameId(existing.user_id, target)) {
      this.event('deletion_key_conflict', { mode });
      throw new AppException('idempotency_conflict');
    }
    this.event('deletion_replay', { mode });
    return this.receipt(existing);
  }

  /** A key inserted concurrently for another target hits the primary key: the same 409. */
  private acceptanceError(error: unknown, mode: 'self' | 'admin'): unknown {
    const dbError = classifyDbError(error);
    if (
      dbError?.kind === 'unique_violation' &&
      dbError.constraint === 'pk_deletion_jobs'
    ) {
      this.event('deletion_key_conflict', { mode });
      return new AppException('idempotency_conflict');
    }
    if (error instanceof AppException)
      this.event('deletion_refused', { mode, reason: error.code });
    return error;
  }

  private self(actor: string, target: string, operation: string): void {
    validateUserId(target);
    this.ownership.assertOwner(actor, target, operation);
  }

  private async lockUser(manager: EntityManager, id: string): Promise<UserRow> {
    const [row] = await manager.query<UserRow[]>(
      `SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE`,
      [uuid(id)],
    );
    if (!row) throw new AppException('invalid_session');
    return row;
  }

  private async jobById(
    manager: EntityManager,
    id: string,
  ): Promise<JobRow | null> {
    const [row] = await manager.query<JobRow[]>(
      `SELECT ${JOB_FIELDS} FROM deletion_jobs WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  /** `lock`: inside a transaction that already holds the user lock (job is last in the order). */
  private async jobForUser(
    manager: EntityManager,
    userId: string | null,
    lock = false,
  ): Promise<JobRow | null> {
    const [row] = await manager.query<JobRow[]>(
      `SELECT ${JOB_FIELDS} FROM deletion_jobs WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    return row ?? null;
  }

  private async refuseIfJob(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    if (await this.jobForUser(manager, userId, true)) {
      this.event('deletion_challenge_refused', { reason: 'job_exists' });
      throw new AppException('deletion_exists');
    }
  }

  private async emailBudget(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const slot = await this.limiter.consume(
      'deletion_challenge_emails',
      [userId],
      manager,
    );
    if (!slot.allowed)
      throw new AppException('too_many_requests', {
        retryAfterSeconds: slot.retryAfterSeconds,
      });
  }

  private async inactive(
    manager: EntityManager,
    userId: string,
  ): Promise<Outcome<never>> {
    await this.challenges.consumeOutstanding(
      manager,
      'deletion',
      userId,
      'user_inactive',
    );
    return {
      ok: false,
      error: new ChallengeRejected('invalid_session', 'user_inactive'),
    };
  }

  private async deliver(
    outcome: Outcome<Delivery>,
  ): Promise<Record<string, unknown>> {
    if (!outcome.ok) throw outcome.error;
    await this.challenges.deliver(outcome.value.address, outcome.value.issued);
    return this.challenges.accepted(outcome.value.issued);
  }

  private receipt(job: JobRow): DeletionReceipt {
    return {
      jobId: job.id,
      status: job.status,
      statusUrl: `/users/${job.user_id}/deletion-status`,
    };
  }

  private statusView(job: JobRow): DeletionStatus {
    return {
      jobId: job.id,
      status: job.status,
      createdAt: job.created_at.toISOString(),
      updatedAt: job.updated_at.toISOString(),
      finishedAt:
        job.status === 'succeeded' && job.finished_at
          ? job.finished_at.toISOString()
          : null,
    };
  }

  /** Spec 1.6 §1.5: the operation and a safe result code, never ids, keys or addresses. */
  private event(event: string, fields: Record<string, string>): void {
    this.logger.log({ event, ...fields }, 'deletion event');
  }
}

interface Delivery {
  issued: IssuedChallenge;
  address: string;
}
