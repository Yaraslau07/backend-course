import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { ErrorCode } from '@/core/errors/error-catalogue';
import { MailService, MailUnavailableError } from '@/core/mail/mail.service';
import type { ChallengeScenario } from '@/core/mail/templates';

import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_RESEND_SECONDS,
  CHALLENGE_SCENARIOS,
  CHALLENGE_TTL_SECONDS,
} from './challenge-scenarios';
import {
  formatToken,
  generateMagicSecret,
  generateOtp,
  hashSecret,
  isChallengeId,
  parseToken,
  secretsEqual,
} from './challenge-secrets';
import type {
  ChallengeConsumedReason,
  ChallengeMethod,
} from './challenges.types';

/** How a request names a challenge: by id (OTP, resend) or by its magic-link token. */
export type ChallengeRef = { challengeId: string } | { token: string };

/** A challenge just created or resent. `secret` is the OTP or the full magic-link token: mail only. */
export interface IssuedChallenge {
  scenario: ChallengeScenario;
  id: string;
  method: ChallengeMethod;
  secret: string;
}

/** A challenge whose secret just matched. The flow acts on it, then claims it. */
export interface ChallengeRecord {
  id: string;
  userId: string;
  method: ChallengeMethod;
  attempts: number;
  /** Email change only: the address being confirmed. */
  newEmail: string | null;
}

/**
 * Why the engine refused, as an AppException with the code the specs give it. `reason` is for the
 * flow and the logs (`not_found`, `expired`, `wrong_secret`, `consumed:replaced`, …): a flow can
 * answer differently (login turns `user_inactive` into 401 invalid_credentials; deletion turns
 * `consumed:job_exists` into its existing job).
 */
export class ChallengeRejected extends AppException {
  constructor(
    code: ErrorCode,
    readonly reason: string,
    extras: { retryAfterSeconds?: number } = {},
  ) {
    super(code, extras);
  }
}

/**
 * Engine calls that change state return their refusal instead of throwing it: a wrong OTP must
 * still commit its counted attempt. The flow commits, then throws `outcome.error`.
 */
export type Refusal = { ok: false; error: ChallengeRejected };
export type Outcome<T> = { ok: true; value: T } | Refusal;

export type ConfirmInput = (
  | { challengeId: string; code: string }
  | { token: string }
) & {
  /** The user the request acts for, already locked by the flow. */
  userId: string;
  /** Whether that user may still confirm (login: active; registration: pending; …). */
  userEligible: boolean;
};

interface ChallengeRow {
  id: string;
  user_id: string;
  method: ChallengeMethod;
  secret_hash: Buffer;
  attempts: number;
  consumed_reason: ChallengeConsumedReason | null;
  new_email: string | null;
  /** Seconds since `last_sent_at`, by the database clock. */
  age: number;
}

const OTP = /^\d{6}$/;

/** Consumed reasons that mean "a later decision replaced this challenge": 409 (specs 1.5, 1.6). */
const CONFLICT_REASONS = new Set<ChallengeConsumedReason>([
  'admin_override',
  'email_conflict',
  'job_exists',
]);

const reject = (
  code: ErrorCode,
  reason: string,
  extras?: { retryAfterSeconds?: number },
): Refusal => ({
  ok: false,
  error: new ChallengeRejected(code, reason, extras),
});

/**
 * One implementation of email challenges for registration, login, email change and deletion
 * (docs/invariants.md, "Email challenges"). Every method that touches a challenge runs inside the
 * flow's transaction, after the flow has locked the user row: the lock order is user → challenge.
 * Delivery happens after commit (`deliver`), so a failed mail never rolls a challenge back.
 */
@Injectable()
export class ChallengeEngine {
  private readonly logger = new Logger('Challenges');

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * The owner of a challenge, read without a lock and without deciding anything, so the flow can
   * lock the user first and the challenge second (spec 1.2 §1.3.2 step 1).
   */
  async findUserId(
    manager: EntityManager,
    scenario: ChallengeScenario,
    ref: ChallengeRef,
  ): Promise<string | null> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const located = this.locate(scenario, ref);
    if (!located) return null;
    const rows = await manager.query<{ user_id: string }[]>(
      'challengeId' in located
        ? `SELECT user_id FROM ${table} WHERE id = $1`
        : `SELECT user_id FROM ${table} WHERE secret_hash = $1 AND consumed_at IS NULL LIMIT 1`,
      ['challengeId' in located ? located.challengeId : located.hash],
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * A new challenge for a locked user. Refused within 60 s of the previous one's last send;
   * otherwise the previous one is consumed as `replaced` (one outstanding challenge per user).
   */
  async issue(
    manager: EntityManager,
    scenario: ChallengeScenario,
    input: { userId: string; method: ChallengeMethod; newEmail?: string },
  ): Promise<Outcome<IssuedChallenge>> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const previous = await this.selectForUpdate(
      manager,
      scenario,
      `user_id = $1 AND consumed_at IS NULL`,
      [input.userId],
    );
    if (previous) {
      if (previous.age < CHALLENGE_RESEND_SECONDS) {
        this.event(scenario, 'issue_rejected', {
          method: input.method,
          reason: 'cooldown',
        });
        return this.cooldown(previous.age);
      }
      await this.claim(manager, scenario, previous.id, 'replaced');
    }

    if ((scenario === 'email_change') !== (input.newEmail !== undefined)) {
      // A programming error, not a client one: only an email change has a target address.
      throw new Error('newEmail is required for email_change and only for it');
    }

    const secret = this.newSecret(input.method);
    const hash = this.hash(scenario, secret);
    // clock_timestamp(), not now(): now() is the transaction's start, which may be before a lock wait.
    const [created] = await manager.query<{ id: string }[]>(
      scenario === 'email_change'
        ? `INSERT INTO ${table} (user_id, method, secret_hash, new_email, last_sent_at, created_at)
           VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp()) RETURNING id`
        : `INSERT INTO ${table} (user_id, method, secret_hash, last_sent_at, created_at)
           VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp()) RETURNING id`,
      scenario === 'email_change'
        ? [input.userId, input.method, hash, input.newEmail]
        : [input.userId, input.method, hash],
    );
    this.event(scenario, 'issued', {
      method: input.method,
      challengeId: created.id,
    });
    return {
      ok: true,
      value: this.issued(scenario, created.id, input.method, secret),
    };
  }

  /**
   * A new secret for the same challenge and method: replaces the hash, resets attempts and
   * restarts the TTL. Allowed after expiry, refused within 60 s of the last send.
   */
  async resend(
    manager: EntityManager,
    scenario: ChallengeScenario,
    input: { challengeId: string; userId: string; userEligible: boolean },
  ): Promise<Outcome<IssuedChallenge>> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const row = isChallengeId(input.challengeId)
      ? await this.selectForUpdate(manager, scenario, `id = $1`, [
          input.challengeId,
        ])
      : null;

    const refusal = this.checkState(row, input.userId);
    if (refusal) return this.rejected(scenario, 'resend_rejected', refusal);
    const challenge = row!;

    if (!input.userEligible) {
      await this.claim(manager, scenario, challenge.id, 'user_inactive');
      return this.rejected(
        scenario,
        'resend_rejected',
        reject('invalid_challenge', 'user_inactive'),
      );
    }
    if (challenge.age < CHALLENGE_RESEND_SECONDS) {
      this.event(scenario, 'resend_rejected', {
        reason: 'cooldown',
        challengeId: challenge.id,
      });
      return this.cooldown(challenge.age);
    }

    const secret = this.newSecret(challenge.method);
    await manager.query(
      `UPDATE ${table} SET secret_hash = $2, attempts = 0, last_sent_at = clock_timestamp() WHERE id = $1`,
      [challenge.id, this.hash(scenario, secret)],
    );
    this.event(scenario, 'resent', {
      method: challenge.method,
      challengeId: challenge.id,
    });
    return {
      ok: true,
      value: this.issued(scenario, challenge.id, challenge.method, secret),
    };
  }

  /**
   * Checks a secret, in the spec's order: found and owned → not consumed → right method →
   * not expired (no attempt counted) → user still eligible → HMAC in constant time. Times are
   * read with clock_timestamp(), so a wait for the row lock still counts towards the TTL. A wrong OTP
   * counts an attempt; the 5th wrong one consumes the challenge as `attempts_exhausted`.
   * On success nothing is consumed yet: the flow acts, then `claim()`s with its reason.
   */
  async confirm(
    manager: EntityManager,
    scenario: ChallengeScenario,
    input: ConfirmInput,
  ): Promise<Outcome<ChallengeRecord>> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const byCode = 'code' in input;
    const ref: ChallengeRef = byCode
      ? { challengeId: input.challengeId }
      : { token: input.token };
    const located = this.locate(scenario, ref);
    if (!located || (byCode && !OTP.test(input.code))) {
      return this.rejected(
        scenario,
        'confirm_rejected',
        reject('invalid_challenge', 'malformed'),
      );
    }

    const row =
      'challengeId' in located
        ? await this.selectForUpdate(manager, scenario, `id = $1`, [
            located.challengeId,
          ])
        : await this.selectForUpdate(
            manager,
            scenario,
            `secret_hash = $1 AND consumed_at IS NULL`,
            [located.hash],
          );

    const refusal = this.checkState(row, input.userId);
    if (refusal) return this.rejected(scenario, 'confirm_rejected', refusal);
    const challenge = row!;
    const ids = { challengeId: challenge.id };
    // A token always carries its secret (locate() only returns one without it for an OTP id).
    const secret = byCode ? input.code : located.secret!;

    if (challenge.method !== (byCode ? 'otp' : 'magic_link')) {
      return this.rejected(
        scenario,
        'confirm_rejected',
        reject('invalid_challenge', 'method_mismatch'),
        ids,
      );
    }
    // Valid until last_sent_at + 10 minutes, so exactly 600 s is already expired.
    if (challenge.age >= CHALLENGE_TTL_SECONDS) {
      return this.rejected(
        scenario,
        'confirm_rejected',
        reject('invalid_challenge', 'expired'),
        ids,
      );
    }
    if (!input.userEligible) {
      await this.claim(manager, scenario, challenge.id, 'user_inactive');
      return this.rejected(
        scenario,
        'confirm_rejected',
        // 400 like every other dead challenge (spec 1.0); flows with a session or a login answer
        // remap the reason: login → 401 invalid_credentials, email change → 401 invalid_session.
        reject('invalid_challenge', 'user_inactive'),
        ids,
      );
    }

    if (!secretsEqual(this.hash(scenario, secret), challenge.secret_hash)) {
      if (challenge.method === 'otp') {
        const [[counted]] = await manager.query<
          [{ consumed_reason: string | null }[], number]
        >(
          `UPDATE ${table}
              SET attempts = attempts + 1,
                  consumed_at = CASE WHEN attempts + 1 >= $2 THEN clock_timestamp() END,
                  consumed_reason = CASE WHEN attempts + 1 >= $2
                                         THEN 'attempts_exhausted'::challenge_consumed_reason END
            WHERE id = $1
        RETURNING consumed_reason`,
          [challenge.id, CHALLENGE_MAX_ATTEMPTS],
        );
        // Still a 400 to the client (spec: "the fifth incorrect entry returns an incorrect-code
        // error"), but exhaustion is its own event in the log (spec 1.2 §1.5).
        if (counted?.consumed_reason === 'attempts_exhausted') {
          this.event(scenario, 'exhausted', ids);
        }
      }
      return this.rejected(
        scenario,
        'confirm_rejected',
        reject('invalid_challenge', 'wrong_secret'),
        ids,
      );
    }

    this.event(scenario, 'confirm_accepted', {
      method: challenge.method,
      ...ids,
    });
    return {
      ok: true,
      value: {
        id: challenge.id,
        userId: challenge.user_id,
        method: challenge.method,
        attempts: challenge.attempts,
        newEmail: challenge.new_email,
      },
    };
  }

  /**
   * Claim-then-act: consumes a challenge only if it is still outstanding, and reports whether this
   * call did it. A flow treats `false` as "someone else already used it".
   */
  async claim(
    manager: EntityManager,
    scenario: ChallengeScenario,
    challengeId: string,
    reason: ChallengeConsumedReason,
  ): Promise<boolean> {
    return (
      (await this.consume(
        manager,
        scenario,
        `id = $1`,
        challengeId,
        reason,
      )) === 1
    );
  }

  /** Consumes the user's outstanding challenge, if any (blocking, admin email change, deletion). */
  async consumeOutstanding(
    manager: EntityManager,
    scenario: ChallengeScenario,
    userId: string,
    reason: ChallengeConsumedReason,
  ): Promise<number> {
    return this.consume(manager, scenario, `user_id = $1`, userId, reason);
  }

  /** The 202 body for an issued or resent challenge. Never contains the secret. */
  accepted(issued: IssuedChallenge): Record<string, unknown> {
    return {
      confirmationRequired: true,
      method: issued.method,
      [CHALLENGE_SCENARIOS[issued.scenario].idField]: issued.id,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: CHALLENGE_RESEND_SECONDS,
    };
  }

  /**
   * Mails the secret, after the challenge is committed. If SMTP fails, the challenge stays and the
   * answer is a 503 with the safe fields the specs list; the client resends after the cooldown.
   */
  async deliver(to: string, issued: IssuedChallenge): Promise<void> {
    try {
      await this.mail.sendChallenge(
        to,
        issued.method === 'otp'
          ? { scenario: issued.scenario, method: 'otp', code: issued.secret }
          : {
              scenario: issued.scenario,
              method: 'magic_link',
              token: issued.secret,
            },
      );
    } catch (error) {
      if (!(error instanceof MailUnavailableError)) throw error;
      throw new AppException('service_unavailable', {
        confirmationRequired: true,
        method: issued.method,
        [CHALLENGE_SCENARIOS[issued.scenario].idField]: issued.id,
        retryAfterSeconds: CHALLENGE_RESEND_SECONDS,
      });
    }
  }

  /* ---------- internals ---------- */

  /** The one conditional consume: only outstanding rows, so a challenge is used once. */
  private async consume(
    manager: EntityManager,
    scenario: ChallengeScenario,
    where: string,
    value: string,
    reason: ChallengeConsumedReason,
  ): Promise<number> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const [, affected] = await manager.query<[unknown, number]>(
      `UPDATE ${table} SET consumed_at = clock_timestamp(), consumed_reason = $2
        WHERE ${where} AND consumed_at IS NULL`,
      [value, reason],
    );
    return affected;
  }

  /** A request's reference in a form we can query by, or null if it is malformed. */
  private locate(
    scenario: ChallengeScenario,
    ref: ChallengeRef,
  ):
    | { challengeId: string; secret?: string }
    | { hash: Buffer; secret: string }
    | null {
    if ('challengeId' in ref) {
      return isChallengeId(ref.challengeId)
        ? { challengeId: ref.challengeId }
        : null;
    }
    const parsed = parseToken(scenario, ref.token);
    if (!parsed) return null;
    return parsed.challengeId
      ? { challengeId: parsed.challengeId, secret: parsed.secret }
      : { hash: this.hash(scenario, parsed.secret), secret: parsed.secret };
  }

  private async selectForUpdate(
    manager: EntityManager,
    scenario: ChallengeScenario,
    where: string,
    params: unknown[],
  ): Promise<ChallengeRow | null> {
    const { table } = CHALLENGE_SCENARIOS[scenario];
    const newEmail =
      scenario === 'email_change' ? 'new_email' : 'NULL::text AS new_email';
    const rows = await manager.query<ChallengeRow[]>(
      `SELECT id, user_id, method, secret_hash, attempts, consumed_reason, ${newEmail},
              extract(epoch FROM clock_timestamp() - last_sent_at)::float8 AS age
         FROM ${table} WHERE ${where} LIMIT 1 FOR UPDATE`,
      params,
    );
    return rows[0] ?? null;
  }

  /** Not found (or someone else's), or already consumed: the shared refusals of resend and confirm. */
  private checkState(row: ChallengeRow | null, userId: string): Refusal | null {
    if (!row || row.user_id !== userId)
      return reject('invalid_challenge', 'not_found');
    if (row.consumed_reason === null) return null;
    const reason = `consumed:${row.consumed_reason}`;
    if (row.consumed_reason === 'attempts_exhausted')
      return reject('attempts_exhausted', reason);
    if (CONFLICT_REASONS.has(row.consumed_reason))
      return reject('challenge_conflict', reason);
    return reject('invalid_challenge', reason);
  }

  private cooldown(age: number): Refusal {
    return reject('resend_cooldown', 'cooldown', {
      retryAfterSeconds: Math.max(1, Math.ceil(CHALLENGE_RESEND_SECONDS - age)),
    });
  }

  private newSecret(method: ChallengeMethod): string {
    return method === 'otp' ? generateOtp() : generateMagicSecret();
  }

  private hash(scenario: ChallengeScenario, secret: string): Buffer {
    return hashSecret(
      this.config.get(CHALLENGE_SCENARIOS[scenario].hmacKey) as string,
      scenario,
      secret,
    );
  }

  private issued(
    scenario: ChallengeScenario,
    id: string,
    method: ChallengeMethod,
    secret: string,
  ): IssuedChallenge {
    return {
      scenario,
      id,
      method,
      secret: method === 'otp' ? secret : formatToken(scenario, id, secret),
    };
  }

  private rejected(
    scenario: ChallengeScenario,
    event: string,
    refusal: Refusal,
    ids: { challengeId?: string } = {},
  ): Refusal {
    this.event(scenario, event, { reason: refusal.error.reason, ...ids });
    return refusal;
  }

  /** Spec 1.2 §1.5: creation, resend, confirmation, invalid input, expiry, exhaustion. No secrets. */
  private event(
    scenario: ChallengeScenario,
    event: string,
    fields: { method?: ChallengeMethod; reason?: string; challengeId?: string },
  ): void {
    const { challengeId, ...rest } = fields;
    this.logger.log(
      {
        scenario,
        event,
        ...rest,
        ...(CHALLENGE_SCENARIOS[scenario].logIds && challengeId
          ? { challengeId }
          : {}),
      },
      'challenge event',
    );
  }
}
