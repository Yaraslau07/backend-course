import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';
import {
  ChallengeEngine,
  ChallengeRejected,
  type IssuedChallenge,
  type Outcome,
} from '@/modules/challenges/challenge-engine.service';

import type { RegisterDto } from './dto/register.dto';
import type { RegistrationConfirmDto } from './dto/registration-confirm.dto';
import type { RegistrationResendDto } from './dto/registration-resend.dto';
import { PasswordHasher } from './password-hasher';

export interface RegisteredUser {
  id: string;
  email: string;
  status: 'active';
}

export type RegistrationResult =
  | { status: 201; body: RegisteredUser }
  | { status: 202; body: Record<string, unknown> };

const isEmailTaken = (error: unknown) => {
  const db = classifyDbError(error);
  return db?.kind === 'unique_violation' && db.constraint === 'uq_users_email';
};

/**
 * Spec 1.0. Registration creates the user (active, or pending with a challenge) but never signs in:
 * no tokens, no cookies. The `user` role is assigned on activation once RBAC exists (C10).
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger('Registration');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly hasher: PasswordHasher,
    private readonly challenges: ChallengeEngine,
  ) {}

  async register(dto: RegisterDto): Promise<RegistrationResult> {
    // The slow hash runs before any transaction, so no lock is held while it computes.
    const passwordHash = await this.hasher.hash(dto.password);
    const confirm = this.config.get('REGISTRATION_EMAIL_CONFIRMATION_ENABLED');

    let created: { id: string; issued?: IssuedChallenge };
    try {
      created = await this.db.transaction(async (manager) => {
        const id = await this.insertUser(
          manager,
          dto.email,
          passwordHash,
          confirm ? 'pending' : 'active',
        );
        if (!confirm) return { id };
        const outcome = await this.challenges.issue(manager, 'registration', {
          userId: id,
          method: this.config.get('REGISTRATION_EMAIL_CONFIRMATION_METHOD'),
        });
        // A user created a moment ago has no earlier challenge, so this can't be a cooldown.
        if (!outcome.ok) throw outcome.error;
        return { id, issued: outcome.value };
      });
    } catch (error) {
      // The unique index decides, including between two concurrent registrations (spec 1.0).
      if (!isEmailTaken(error)) throw error;
      this.event('email_taken');
      throw new AppException('email_taken');
    }

    if (!created.issued) {
      this.event('registered', created.id);
      return {
        status: 201,
        body: { id: created.id, email: dto.email, status: 'active' },
      };
    }

    this.event('pending_created', created.id);
    // After commit: if the mail fails, the pending user and the challenge stay, and the answer is
    // the 503 with the safe fields. A second registration then gets 409; only resend delivers.
    await this.challenges.deliver(dto.email, created.issued);
    return { status: 202, body: this.challenges.accepted(created.issued) };
  }

  async confirm(dto: RegistrationConfirmDto): Promise<RegisteredUser> {
    const ref = this.confirmVariant(dto);
    const userId = await this.challenges.findUserId(
      this.db.manager,
      'registration',
      ref,
    );
    if (!userId) {
      this.event('confirm_rejected', undefined, 'not_found');
      throw new AppException('invalid_challenge');
    }

    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<RegisteredUser>> => {
        const user = await this.lockUser(manager, `id = $1`, userId);
        if (!user) {
          return {
            ok: false,
            error: new ChallengeRejected('invalid_challenge', 'not_found'),
          };
        }
        const checked = await this.challenges.confirm(manager, 'registration', {
          ...('token' in ref
            ? { token: ref.token }
            : { challengeId: ref.challengeId, code: dto.code! }),
          userId,
          // Only a pending registration can be confirmed; an active or blocked one is a dead challenge.
          userEligible: user.status === 'pending',
        });
        if (!checked.ok) return checked;
        // Claim, then act: a challenge used concurrently can't activate twice.
        if (
          !(await this.challenges.claim(
            manager,
            'registration',
            checked.value.id,
            'confirmed',
          ))
        ) {
          return {
            ok: false,
            error: new ChallengeRejected('invalid_challenge', 'claim_lost'),
          };
        }
        await manager.query(
          `UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`,
          [userId],
        );
        return {
          ok: true,
          value: { id: user.id, email: user.email, status: 'active' },
        };
      },
    );

    if (!outcome.ok) {
      this.event('confirm_rejected', userId, outcome.error.reason);
      throw outcome.error;
    }
    this.event('confirmed', userId);
    return outcome.value;
  }

  /**
   * A new email for a pending registration. The outstanding challenge is resent (same id); if the
   * last one is used up (exhausted, replaced), a new one is issued, with the 60 s cooldown still
   * counted from the last mail (D41).
   */
  async resend(dto: RegistrationResendDto): Promise<Record<string, unknown>> {
    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<IssuedChallenge>> => {
        const user = await this.lockUser(manager, `email = $1`, dto.email);
        // Unknown and not pending look the same: there is no challenge to resend.
        if (!user || user.status !== 'pending') {
          return {
            ok: false,
            error: new ChallengeRejected('invalid_challenge', 'not_found'),
          };
        }
        const latest = await this.challenges.latest(
          manager,
          'registration',
          user.id,
        );
        if (latest?.outstanding) {
          return this.challenges.resend(manager, 'registration', {
            challengeId: latest.id,
            userId: user.id,
            userEligible: true,
          });
        }
        return this.challenges.issue(manager, 'registration', {
          userId: user.id,
          // The method recorded with the registration, even if the setting changed since (spec 1.0).
          method:
            latest?.method ??
            this.config.get('REGISTRATION_EMAIL_CONFIRMATION_METHOD'),
          cooldownFromLatest: true,
        });
      },
    );

    if (!outcome.ok) {
      this.event('resend_rejected', undefined, outcome.error.reason);
      throw outcome.error;
    }
    this.event('resent');
    await this.challenges.deliver(dto.email, outcome.value);
    return this.challenges.accepted(outcome.value);
  }

  /** `attemptId` + `code`, or `token`, and nothing else. */
  private confirmVariant(
    dto: RegistrationConfirmDto,
  ): { challengeId: string } | { token: string } {
    const otp = dto.attemptId !== undefined && dto.code !== undefined;
    const link = dto.token !== undefined;
    const partial = (dto.attemptId !== undefined) !== (dto.code !== undefined);
    if (otp === link || partial) {
      throw new AppException('validation_failed', {
        errors: [{ field: 'body', rules: ['exactlyOneVariant'] }],
      });
    }
    return link ? { token: dto.token! } : { challengeId: dto.attemptId! };
  }

  private async insertUser(
    manager: EntityManager,
    email: string,
    passwordHash: string,
    status: 'active' | 'pending',
  ): Promise<string> {
    const [row] = await manager.query<{ id: string }[]>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, $3) RETURNING id`,
      [email, passwordHash, status],
    );
    return row.id;
  }

  private async lockUser(
    manager: EntityManager,
    where: 'id = $1' | 'email = $1',
    value: string,
  ): Promise<{ id: string; email: string; status: string } | undefined> {
    const rows = await manager.query<
      { id: string; email: string; status: string }[]
    >(`SELECT id, email, status FROM users WHERE ${where} FOR UPDATE`, [value]);
    return rows[0];
  }

  /** Spec 1.0 §1.5: attempts, sends, confirmations. By user id; never the email or password. */
  private event(event: string, userId?: string, reason?: string): void {
    this.logger.log({ event, userId, reason }, 'registration event');
  }
}
