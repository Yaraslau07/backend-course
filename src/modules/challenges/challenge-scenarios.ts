import type { AppConfig } from '@/core/config/config.types';
import type { ChallengeScenario } from '@/core/mail/templates';

export interface ChallengeScenarioConfig {
  /** The scenario's own table (D13). Interpolated into SQL, so only these constants are ever used. */
  table: string;
  /** Each scenario has its own HMAC key; none is shared (spec 1.2, 1.5, 1.6). */
  hmacKey: keyof AppConfig;
  /** What the challenge id is called in responses: `attemptId` (1.0, 1.2) or `challengeId` (1.5, 1.6). */
  idField: 'attemptId' | 'challengeId';
  /**
   * Whether a magic-link token is `id.secret`. Registration's is the secret alone and the
   * challenge is found by its HMAC (spec 1.0 §1.3.2).
   */
  tokenCarriesId: boolean;
  /** Deletion events may not carry ids in logs (spec 1.6 §1.5). */
  logIds: boolean;
}

export const CHALLENGE_SCENARIOS: Record<
  ChallengeScenario,
  ChallengeScenarioConfig
> = {
  registration: {
    table: 'registration_challenges',
    hmacKey: 'REGISTRATION_CHALLENGE_HMAC_KEY',
    idField: 'attemptId',
    tokenCarriesId: false,
    logIds: true,
  },
  login: {
    table: 'login_challenges',
    hmacKey: 'LOGIN_CHALLENGE_HMAC_KEY',
    idField: 'attemptId',
    tokenCarriesId: true,
    logIds: true,
  },
  email_change: {
    table: 'email_change_challenges',
    hmacKey: 'EMAIL_CHANGE_HMAC_KEY',
    idField: 'challengeId',
    tokenCarriesId: true,
    logIds: true,
  },
  deletion: {
    table: 'deletion_challenges',
    hmacKey: 'DELETION_CHALLENGE_HMAC_KEY',
    idField: 'challengeId',
    tokenCarriesId: true,
    logIds: false,
  },
};

/** A challenge is valid for 10 minutes from its last send (invariants, "Email challenges"). */
export const CHALLENGE_TTL_SECONDS = 600;
/** A new email (resend or new challenge) at most once per 60 s from the last send. */
export const CHALLENGE_RESEND_SECONDS = 60;
/** OTP inputs per send; the 5th is still checked. */
export const CHALLENGE_MAX_ATTEMPTS = 5;
