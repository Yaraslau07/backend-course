/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import type { ChallengeScenario } from '@/core/mail/templates';

export function generateOtp(): string {
  throw new Error('not implemented');
}
export function generateMagicSecret(): string {
  throw new Error('not implemented');
}
export function hashSecret(
  _key: string,
  _scenario: ChallengeScenario,
  _secret: string,
): Buffer {
  throw new Error('not implemented');
}
export function secretsEqual(_a: Buffer, _b: Buffer): boolean {
  throw new Error('not implemented');
}
export function formatToken(
  _scenario: ChallengeScenario,
  _id: string,
  _secret: string,
): string {
  throw new Error('not implemented');
}
export function parseToken(
  _scenario: ChallengeScenario,
  _token: string,
): { challengeId?: string; secret: string } | null {
  throw new Error('not implemented');
}
