/** Only `active` authenticates; see "User statuses" in docs/invariants.md. */
export const USER_STATUSES = [
  'pending',
  'active',
  'blocked',
  'deleting',
  'deleted',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const DELETION_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
] as const;
export type DeletionJobStatus = (typeof DELETION_JOB_STATUSES)[number];
