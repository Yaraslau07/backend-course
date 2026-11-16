import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import type { ChallengeScenario } from '@/core/mail/templates';

import { CHALLENGE_SCENARIOS } from './challenge-scenarios';

const DOMAIN = 'email-challenge:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 bytes in base64url without padding. */
const MAGIC_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Six digits, uniform over 000000–999999 (`randomInt` has no modulo bias). */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 32 random bytes, base64url (spec 1.0, 1.2: "32 random bytes before base64url encoding"). */
export function generateMagicSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * HMAC-SHA256 under the scenario's key, with a domain prefix naming the scenario, so a secret
 * can't be recovered from the database and a hash from one scenario never matches another.
 */
export function hashSecret(
  base64urlKey: string,
  scenario: ChallengeScenario,
  secret: string,
): Buffer {
  return createHmac('sha256', Buffer.from(base64urlKey, 'base64url'))
    .update(`${DOMAIN}\0${scenario}\0${secret}`)
    .digest();
}

/** Constant-time comparison of two hashes. */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isChallengeId(value: string): boolean {
  return UUID.test(value);
}

/** What goes into the magic link: `id.secret`, or the secret alone for registration. */
export function formatToken(
  scenario: ChallengeScenario,
  id: string,
  secret: string,
): string {
  return CHALLENGE_SCENARIOS[scenario].tokenCarriesId
    ? `${id}.${secret}`
    : secret;
}

/** Splits a magic-link token; null for anything not in the scenario's exact format. */
export function parseToken(
  scenario: ChallengeScenario,
  token: string,
): { challengeId?: string; secret: string } | null {
  if (!CHALLENGE_SCENARIOS[scenario].tokenCarriesId) {
    return MAGIC_SECRET.test(token) ? { secret: token } : null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [challengeId, secret] = parts;
  return UUID.test(challengeId) && MAGIC_SECRET.test(secret)
    ? { challengeId, secret }
    : null;
}
