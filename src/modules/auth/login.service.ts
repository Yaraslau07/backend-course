import { randomBytes } from 'node:crypto';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { pseudonymize } from '@/core/logging/pseudonymize';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import {
  ChallengeEngine,
  ChallengeRejected,
  type ChallengeRef,
  type IssuedChallenge,
  type Outcome,
} from '@/modules/challenges/challenge-engine.service';

import type { LoginDto } from './dto/login.dto';
import type { LoginConfirmDto } from './dto/login-confirm.dto';
import type { LoginResendDto } from './dto/login-resend.dto';
import { PasswordHasher } from './password-hasher';
import { TokenService, type TokenPair } from './tokens/token.service';

export type LoginResult =
  | { kind: 'session'; pair: TokenPair }
  | { kind: 'challenge'; body: Record<string, unknown> };

interface LockedUser {
  id: string;
  email: string;
  status: string;
}

const refusal = (code: 'invalid_credentials', reason: string) => ({
  ok: false as const,
  error: new ChallengeRejected(code, reason),
});

/**
 * Spec 1.2 §1.3.1–1.3.2: login by email and password, with the optional email step. Tokens are
 * signed before any cookie is set (TokenService), and the email step follows the engine's rules:
 * user lock → challenge lock, commit before SMTP, refusals committed then thrown.
 */
@Injectable()
export class LoginService implements OnModuleInit {
  private readonly logger = new Logger('Auth');
  /**
   * The hash an unknown email is checked against, so every login runs exactly one argon2 verify
   * with the same parameters, whether the user exists or not (spec 1.2 §1.3.1 step 2).
   */
  private dummyHash = '';

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly challenges: ChallengeEngine,
    private readonly limiter: RateLimiter,
  ) {}

  async onModuleInit(): Promise<void> {
    // A random password nobody knows, hashed once per process with the real parameters.
    this.dummyHash = await this.hasher.hash(
      randomBytes(32).toString('base64url'),
    );
  }

  async login(dto: LoginDto, ip: string): Promise<LoginResult> {
    // Failure-only limit (D32): take a slot before the slow check, so concurrent guesses can't
    // all slip past 5. Only a decided 401 keeps it (D44): unknown emails count too, or the limit
    // would tell which emails exist; a success, a cooldown or an outage gives it back.
    const limitKey = [dto.email, ip];
    const slot = await this.limiter.consume('login_failures', limitKey);
    if (!slot.allowed) {
      this.event('login', 'rate_limited', {
        reason: 'login_failures',
        emailPseudonym: this.pseudonym(dto.email),
      });
      throw new AppException('too_many_requests', {
        retryAfterSeconds: slot.retryAfterSeconds,
      });
    }

    let result: LoginResult;
    try {
      result = await this.attempt(dto);
    } catch (error) {
      const credentialFailure =
        error instanceof AppException && error.code === 'invalid_credentials';
      if (!credentialFailure) {
        await this.limiter.release('login_failures', limitKey);
      }
      throw error;
    }
    await this.limiter.release('login_failures', limitKey);
    return result;
  }

  /** Spec 1.2 §1.3.1 steps 2–8, once the failure limit has allowed the attempt. */
  private async attempt(dto: LoginDto): Promise<LoginResult> {
    const [user] = await this.db.query<
      (LockedUser & { password_hash: string | null })[]
    >(`SELECT id, email, status, password_hash FROM users WHERE email = $1`, [
      dto.email,
    ]);
    // One verify per attempt, always: a deleted user has no hash and is checked like an unknown one.
    const matches = await this.hasher.verify(
      user?.password_hash ?? this.dummyHash,
      dto.password,
    );
    if (!user) this.refuseLogin('unknown_email', undefined, dto.email);
    // A deleted user has no hash: not a wrong password, an inactive account.
    if (!user.password_hash) this.refuseLogin('user_inactive', user.id);
    if (!matches) this.refuseLogin('wrong_password', user.id);
    if (user.status !== 'active') this.refuseLogin('user_inactive', user.id);

    if (!this.config.get('LOGIN_EMAIL_CONFIRMATION_ENABLED')) {
      const pair = this.tokens.issuePair(user.id);
      this.event('login', 'success', { userId: user.id });
      return { kind: 'session', pair };
    }
    return { kind: 'challenge', body: await this.startChallenge(user.id) };
  }

  async confirm(dto: LoginConfirmDto): Promise<TokenPair> {
    const ref = this.confirmVariant(dto);
    const userId = await this.challenges.findUserId(
      this.db.manager,
      'login',
      ref,
    );
    if (!userId) {
      this.event('login_confirm', 'failure', { reason: 'not_found' });
      throw new AppException('invalid_challenge');
    }

    const outcome = await this.db.transaction(
      async (manager): Promise<Outcome<{ pair: TokenPair; id: string }>> => {
        const user = await this.lockUser(manager, userId);
        const checked = await this.challenges.confirm(manager, 'login', {
          ...('token' in ref
            ? { token: ref.token }
            : { challengeId: ref.challengeId, code: dto.code! }),
          userId,
          userEligible: user?.status === 'active',
        });
        if (!checked.ok) return checked;
        // Signed before the claim and the commit: if signing fails, the transaction rolls back and
        // the same code can be tried again (spec 1.2 §1.3.2).
        const pair = this.tokens.issuePair(userId);
        if (
          !(await this.challenges.claim(
            manager,
            'login',
            checked.value.id,
            'confirmed',
          ))
        ) {
          return {
            ok: false,
            error: new ChallengeRejected('invalid_challenge', 'claim_lost'),
          };
        }
        return { ok: true, value: { pair, id: checked.value.id } };
      },
    );

    if (!outcome.ok) {
      this.event('login_confirm', 'failure', {
        userId,
        reason: outcome.error.reason,
      });
      throw this.forLogin(outcome.error);
    }
    this.event('login_confirm', 'success', {
      userId,
      attemptId: outcome.value.id,
    });
    return outcome.value.pair;
  }

  async resend(dto: LoginResendDto): Promise<Record<string, unknown>> {
    const userId = await this.challenges.findUserId(this.db.manager, 'login', {
      challengeId: dto.attemptId,
    });
    if (!userId) {
      this.event('login_resend', 'failure', { reason: 'not_found' });
      throw new AppException('invalid_challenge');
    }

    const outcome = await this.db.transaction(
      async (
        manager,
      ): Promise<Outcome<{ issued: IssuedChallenge; email: string }>> => {
        const user = await this.lockUser(manager, userId);
        const resent = await this.challenges.resend(manager, 'login', {
          challengeId: dto.attemptId,
          userId,
          userEligible: user?.status === 'active',
        });
        return resent.ok
          ? { ok: true, value: { issued: resent.value, email: user!.email } }
          : resent;
      },
    );

    if (!outcome.ok) {
      this.event('login_resend', 'failure', {
        userId,
        reason: outcome.error.reason,
      });
      throw this.forLogin(outcome.error);
    }
    const { issued, email } = outcome.value;
    this.event('login_resend', 'success', {
      userId,
      attemptId: issued.id,
      method: issued.method,
    });
    await this.challenges.deliver(email, issued);
    return this.challenges.accepted(issued);
  }

  /** Spec 1.2 §1.3.1 steps 6–8: a challenge for a user whose password just matched. */
  private async startChallenge(
    userId: string,
  ): Promise<Record<string, unknown>> {
    const outcome = await this.db.transaction(
      async (
        manager,
      ): Promise<Outcome<{ issued: IssuedChallenge; email: string }>> => {
        const user = await this.lockUser(manager, userId);
        // Re-checked under the lock: the status may have changed since the password check.
        if (user?.status !== 'active') {
          return refusal('invalid_credentials', 'user_inactive');
        }
        const issued = await this.challenges.issue(manager, 'login', {
          userId,
          method: this.config.get('LOGIN_EMAIL_CONFIRMATION_METHOD'),
        });
        return issued.ok
          ? { ok: true, value: { issued: issued.value, email: user.email } }
          : issued;
      },
    );

    if (!outcome.ok) {
      this.event('login_challenge', 'failure', {
        userId,
        reason: outcome.error.reason,
      });
      throw outcome.error;
    }
    const { issued, email } = outcome.value;
    this.event('login_challenge', 'created', {
      userId,
      attemptId: issued.id,
      method: issued.method,
    });
    // After commit: if SMTP refuses, the attempt stays and the answer is the 503 with safe fields.
    await this.challenges.deliver(email, issued);
    return this.challenges.accepted(issued);
  }

  /**
   * A user who is no longer active gets the login's own 401, not the engine's 400 (spec 1.2
   * §1.3.2 step 4; for resend, D42). The challenge was already consumed as `user_inactive`.
   */
  private forLogin(error: ChallengeRejected): AppException {
    return error.reason === 'user_inactive'
      ? new AppException('invalid_credentials')
      : error;
  }

  /** `attemptId` + `code`, or `token`, and nothing else. */
  private confirmVariant(dto: LoginConfirmDto): ChallengeRef {
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

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<LockedUser | undefined> {
    const rows = await manager.query<LockedUser[]>(
      `SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    return rows[0];
  }

  /** The one 401 for every login failure; the log keeps the reason, by user id or pseudonym. */
  private refuseLogin(reason: string, userId?: string, email?: string): never {
    this.event('login', 'failure', {
      reason,
      userId,
      ...(email === undefined ? {} : { emailPseudonym: this.pseudonym(email) }),
    });
    throw new AppException('invalid_credentials');
  }

  /** An irreversible id for an email, so attacks on one address can be matched in logs. */
  private pseudonym(email: string): string {
    return pseudonymize(email, this.config.get('LOG_PSEUDONYM_HMAC_KEY'));
  }

  /** Spec 1.2 §1.5: event, result, user id, method and attempt id. Never the email or secrets. */
  private event(
    event: string,
    result: string,
    fields: {
      userId?: string;
      attemptId?: string;
      method?: string;
      reason?: string;
      emailPseudonym?: string;
    },
  ): void {
    const log = result === 'success' || result === 'created' ? 'log' : 'warn';
    this.logger[log]({ event, result, ...fields }, 'auth event');
  }
}
