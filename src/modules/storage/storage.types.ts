export const STORAGE_CLEANUP_REASONS = [
  'photo_replaced',
  'photo_cleared',
] as const;
export type StorageCleanupReason = (typeof STORAGE_CLEANUP_REASONS)[number];

export const STORAGE_CLEANUP_STATUSES = [
  'queued',
  'succeeded',
  'failed',
] as const;
export type StorageCleanupStatus = (typeof STORAGE_CLEANUP_STATUSES)[number];
