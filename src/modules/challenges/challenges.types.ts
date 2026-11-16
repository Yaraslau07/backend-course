export const CHALLENGE_METHODS = ['otp', 'magic_link'] as const;
export type ChallengeMethod = (typeof CHALLENGE_METHODS)[number];

/** Why a challenge stopped being usable; see "Email challenges" in docs/invariants.md. */
export const CHALLENGE_CONSUMED_REASONS = [
  'confirmed',
  'replaced',
  'attempts_exhausted',
  'user_inactive',
  'admin_override',
  'email_conflict',
  'job_exists',
] as const;
export type ChallengeConsumedReason =
  (typeof CHALLENGE_CONSUMED_REASONS)[number];
