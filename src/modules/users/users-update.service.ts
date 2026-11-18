import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';
import { Ownership } from '@/core/authorization/ownership';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';
import {
  lockRbacPolicy,
  assertRbacManagerRemains,
} from '@/modules/rbac/rbac-invariant';
import {
  ChallengeEngine,
  ChallengeRejected,
  type Outcome,
  type IssuedChallenge,
} from '@/modules/challenges/challenge-engine.service';
import {
  ObjectStorage,
  STORAGE_ADOPTION_LOCK,
} from '@/modules/storage/object-storage';
import { safeProfile, type ProfileRow, type SafeProfile } from './safe-profile';
import { PhotoNormalizer, type PhotoInput } from './photo-normalizer';
import {
  patchFields,
  normalizePatch,
  emailInput,
  challengeInput,
} from './update-input';
import { validateUserId } from './user-list-query';
import { uuidOrNull } from './user-ids';

const FIELDS =
  'id, email, display_name, photo_key, status, created_at, updated_at';
const uuid = uuidOrNull;

@Injectable()
export class UsersUpdateService {
  private readonly logger = new Logger('UsersUpdate');
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly ownership: Ownership,
    private readonly authorizer: RbacAuthorizer,
    private readonly challenges: ChallengeEngine,
    private readonly limiter: RateLimiter,
    private readonly storage: ObjectStorage,
    private readonly photos: PhotoNormalizer,
  ) {}

  async patch(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<SafeProfile> {
    const fields = patchFields(raw);
    await this.permit(actor, target, 'patch');
    if (Object.hasOwn(fields, 'email') || Object.hasOwn(fields, 'status'))
      await this.authorizer.authorize(
        actor,
        'users',
        'update_any',
        'UsersUpdate.patchAdminFields',
      );
    const input = normalizePatch(fields);
    return this.audit(actor, target, 'patch', Object.keys(input), async () => {
      return this.db.transaction(async (manager) => {
        if (input.status !== undefined) await lockRbacPolicy(manager);
        const row = await this.lock(manager, target);
        this.editable(row);
        const sets: string[] = [];
        const values: unknown[] = [row.id];
        const add = (column: string, value: unknown) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        };
        if (
          input.displayName !== undefined &&
          input.displayName !== row.display_name
        )
          add('display_name', input.displayName);
        const emailChanged =
          input.email !== undefined && input.email !== row.email;
        const statusChanged =
          input.status !== undefined && input.status !== row.status;
        if (emailChanged) add('email', input.email);
        if (statusChanged) add('status', input.status);
        if (!sets.length) return this.view(row);
        const [[updated]] = await manager.query<[ProfileRow[], number]>(
          `UPDATE users SET ${sets.join(', ')}, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${FIELDS}`,
          values,
        );
        if (emailChanged)
          await this.challenges.consumeOutstanding(
            manager,
            'email_change',
            row.id,
            'admin_override',
          );
        if (statusChanged && input.status === 'blocked') {
          await assertRbacManagerRemains(manager);
          await this.challenges.consumeOutstanding(
            manager,
            'login',
            row.id,
            'user_inactive',
          );
          await this.challenges.consumeOutstanding(
            manager,
            'email_change',
            row.id,
            'user_inactive',
          );
        }
        if (statusChanged) {
          await manager.query(
            `UPDATE rbac_policy_state SET version = version + 1, updated_at = clock_timestamp() WHERE id = 1`,
          );
          this.logger.log(
            {
              event: 'user_status',
              actorUserId: actor,
              targetUserId: row.id,
              from: row.status,
              to: input.status,
            },
            'user status changed',
          );
        }
        return this.view(updated);
      });
    });
  }

  async startEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    this.self(actor, target);
    const address = emailInput(raw);
    const outcome = await this.db.transaction(
      async (
        manager,
      ): Promise<Outcome<{ issued: IssuedChallenge; address: string }>> => {
        const row = await this.lock(manager, actor);
        if (row.status !== 'active') return this.inactive(manager, actor);
        if (row.email === address) throw new AppException('conflict');
        const [occupied] = await manager.query<{ id: string }[]>(
          `SELECT id FROM users WHERE email = $1`,
          [address],
        );
        if (occupied) throw new AppException('email_taken');
        const issued = await this.challenges.issue(manager, 'email_change', {
          userId: actor,
          method: this.config.get('EMAIL_CHANGE_METHOD'),
          newEmail: address,
        });
        if (!issued.ok) return issued;
        await this.emailBudget(manager, actor);
        return { ok: true, value: { issued: issued.value, address } };
      },
    );
    return this.deliver(outcome);
  }

  async resendEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    this.self(actor, target);
    const input = challengeInput(raw, true);
    if (!('challengeId' in input)) throw new AppException('bad_request');
    const outcome = await this.db.transaction(
      async (
        manager,
      ): Promise<Outcome<{ issued: IssuedChallenge; address: string }>> => {
        const row = await this.lock(manager, actor);
        if (row.status !== 'active') return this.inactive(manager, actor);
        const issued = await this.challenges.resend(manager, 'email_change', {
          userId: actor,
          challengeId: input.challengeId,
          userEligible: true,
        });
        if (!issued.ok) return issued;
        const [challenge] = await manager.query<{ new_email: string }[]>(
          `SELECT new_email FROM email_change_challenges WHERE id = $1 AND user_id = $2`,
          [issued.value.id, actor],
        );
        await this.emailBudget(manager, actor);
        return {
          ok: true,
          value: { issued: issued.value, address: challenge.new_email },
        };
      },
    );
    return this.deliver(outcome);
  }

  async confirmEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<SafeProfile> {
    this.self(actor, target);
    const input = challengeInput(raw);
    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<SafeProfile>> => {
        const row = await this.lock(manager, actor);
        if (row.status !== 'active') return this.inactive(manager, actor);
        const checked = await this.challenges.confirm(manager, 'email_change', {
          userId: actor,
          userEligible: true,
          ...('token' in input
            ? { token: input.token }
            : { challengeId: input.challengeId, code: input.code! }),
        });
        if (!checked.ok) return checked;
        await manager.query('SAVEPOINT email_update');
        try {
          if (
            !(await this.challenges.claim(
              manager,
              'email_change',
              checked.value.id,
              'confirmed',
            ))
          )
            throw new AppException('invalid_challenge');
          const [[updated]] = await manager.query<[ProfileRow[], number]>(
            `UPDATE users SET email = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${FIELDS}`,
            [actor, checked.value.newEmail],
          );
          await manager.query('RELEASE SAVEPOINT email_update');
          return { ok: true, value: this.view(updated) };
        } catch (error) {
          const dbError = classifyDbError(error);
          if (
            dbError?.kind !== 'unique_violation' ||
            dbError.constraint !== 'uq_users_email'
          )
            throw error;
          await manager.query('ROLLBACK TO SAVEPOINT email_update');
          await this.challenges.claim(
            manager,
            'email_change',
            checked.value.id,
            'email_conflict',
          );
          await manager.query('RELEASE SAVEPOINT email_update');
          return {
            ok: false,
            error: new ChallengeRejected('email_taken', 'email_conflict'),
          };
        }
      },
    );
    this.logger.log(
      {
        event: 'email_change_confirm',
        actorUserId: actor,
        result: outcome.ok ? 'success' : 'refused',
      },
      'email confirmation finished',
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async upload(
    actor: string,
    target: string,
    load: () => Promise<PhotoInput>,
  ): Promise<SafeProfile> {
    await this.permit(actor, target, 'photo');
    const [before] = await this.db.query<ProfileRow[]>(
      `SELECT ${FIELDS} FROM users WHERE id = $1`,
      [uuid(target)],
    );
    if (!before) throw new AppException('not_found');
    this.editable(before);
    const bytes = await this.photos.normalize(await load());
    const key = `${randomBytes(16).toString('hex')}.webp`;
    let stored = false;
    return this.audit(actor, target, 'photo_upload', [], async () => {
      try {
        return await this.db.transaction(async (manager) => {
          // Protect adoption against the >1h orphan sweep without serializing concurrent uploads.
          await manager.query('SELECT pg_advisory_xact_lock_shared($1)', [
            STORAGE_ADOPTION_LOCK,
          ]);
          if ((await this.storage.write(key, bytes)) !== 'stored')
            throw new AppException('service_unavailable');
          stored = true;
          const row = await this.lock(manager, target);
          this.editable(row);
          const [[updated]] = await manager.query<[ProfileRow[], number]>(
            `UPDATE users SET photo_key = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${FIELDS}`,
            [row.id, key],
          );
          if (row.photo_key)
            await this.enqueue(manager, row.photo_key, 'photo_replaced');
          return this.view(updated);
        });
      } catch (error) {
        if (stored) {
          // A lost COMMIT acknowledgement may mean adoption succeeded. Never delete a referenced key.
          try {
            await this.db.transaction(async (manager) => {
              // Wait for any in-flight COMMIT/rollback on the original target before checking
              // adoption. An unlocked MVCC read could still see the pre-COMMIT reference.
              await manager.query(
                'SELECT id FROM users WHERE id = $1 FOR UPDATE',
                [uuid(target)],
              );
              const [reference] = await manager.query<{ id: string }[]>(
                `SELECT id FROM users WHERE photo_key = $1 LIMIT 1`,
                [key],
              );
              if (!reference) await this.storage.delete(key);
            });
          } catch {
            this.logger.warn(
              { category: 'upload_rollback_cleanup' },
              'deferred orphan reconciliation required',
            );
          }
        }
        throw error;
      }
    });
  }

  async clearPhoto(actor: string, target: string): Promise<void> {
    await this.permit(actor, target, 'photo');
    await this.audit(actor, target, 'photo_clear', [], () =>
      this.db.transaction(async (manager) => {
        const row = await this.lock(manager, target);
        this.editable(row);
        if (!row.photo_key) return;
        await manager.query(
          `UPDATE users SET photo_key = NULL, updated_at = clock_timestamp() WHERE id = $1`,
          [row.id],
        );
        await this.enqueue(manager, row.photo_key, 'photo_cleared');
      }),
    );
  }
  private async permit(
    actor: string,
    target: string,
    operation: string,
  ): Promise<void> {
    validateUserId(target);
    await this.ownership.selfOr(
      actor,
      target,
      'users',
      'update_any',
      `UsersUpdate.${operation}`,
    );
  }
  private self(actor: string, target: string): void {
    validateUserId(target);
    this.ownership.assertOwner(actor, target, 'UsersUpdate.emailChange');
  }
  private async lock(
    manager: EntityManager,
    target: string,
  ): Promise<ProfileRow> {
    const [row] = await manager.query<ProfileRow[]>(
      `SELECT ${FIELDS} FROM users WHERE id = $1 FOR UPDATE`,
      [uuid(target)],
    );
    if (!row) throw new AppException('not_found');
    return row;
  }
  private editable(row: ProfileRow): void {
    if (row.status !== 'active' && row.status !== 'blocked')
      throw new AppException('conflict');
  }
  private view(row: ProfileRow): SafeProfile {
    return safeProfile(row, this.config.get('PUBLIC_API_BASE_URL'));
  }
  private async emailBudget(
    manager: EntityManager,
    actor: string,
  ): Promise<void> {
    const slot = await this.limiter.consume(
      'email_change_emails',
      [actor],
      manager,
    );
    if (!slot.allowed)
      throw new AppException('too_many_requests', {
        retryAfterSeconds: slot.retryAfterSeconds,
      });
  }
  private async inactive(
    manager: EntityManager,
    actor: string,
  ): Promise<Outcome<never>> {
    await this.challenges.consumeOutstanding(
      manager,
      'email_change',
      actor,
      'user_inactive',
    );
    return {
      ok: false,
      error: new ChallengeRejected('invalid_session', 'user_inactive'),
    };
  }
  private async deliver(
    outcome: Outcome<{ issued: IssuedChallenge; address: string }>,
  ): Promise<Record<string, unknown>> {
    if (!outcome.ok) throw outcome.error;
    await this.challenges.deliver(outcome.value.address, outcome.value.issued);
    return this.challenges.accepted(outcome.value.issued);
  }
  private async enqueue(
    manager: EntityManager,
    key: string,
    reason: 'photo_replaced' | 'photo_cleared',
  ): Promise<void> {
    const [job] = await manager.query<{ id: string }[]>(
      `INSERT INTO storage_cleanup_jobs (storage_key, reason) VALUES ($1, $2) RETURNING id`,
      [key, reason],
    );
    this.logger.log(
      { event: 'storage_cleanup_created', jobId: job.id, reason },
      'storage cleanup queued',
    );
  }
  private async audit<T>(
    actor: string,
    target: string,
    operation: string,
    fields: string[],
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      this.logger.log(
        {
          event: 'user_update',
          actorUserId: actor,
          targetUserId: target,
          operation,
          fields,
          result: 'success',
        },
        'user update finished',
      );
      return result;
    } catch (error) {
      const dbError = classifyDbError(error);
      this.logger.warn(
        {
          event: 'user_update',
          actorUserId: actor,
          targetUserId: target,
          operation,
          fields,
          result: 'failure',
          category:
            error instanceof AppException
              ? error.code
              : (dbError?.kind ?? 'dependency'),
        },
        'user update failed',
      );
      if (
        dbError?.kind === 'unique_violation' &&
        dbError.constraint === 'uq_users_email'
      )
        throw new AppException('email_taken');
      throw error;
    }
  }
}
