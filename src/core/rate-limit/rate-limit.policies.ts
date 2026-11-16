/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import type { AppConfig } from '@/core/config/config.types';

export interface RateLimitPolicy {
  by: 'ip' | 'user' | 'custom';
  limit: number | ((config: AppConfig) => number);
  windowSeconds: number;
  spec: string;
}

type Names =
  | 'registration_ip'
  | 'registration_resend_ip'
  | 'login_ip'
  | 'login_failures'
  | 'refresh_ip'
  | 'profile_read_self'
  | 'profile_read_foreign'
  | 'user_update'
  | 'email_change_emails'
  | 'deletion_challenge_emails'
  | 'deletion_status_ip'
  | 'users_list_user'
  | 'users_list_ip'
  | 'history_user';

export const RATE_LIMIT_POLICIES = {} as Record<Names, RateLimitPolicy>;
export type RateLimitPolicyName = Names;
export type RateLimitName = Exclude<
  Names,
  | 'login_failures'
  | 'profile_read_self'
  | 'profile_read_foreign'
  | 'email_change_emails'
  | 'deletion_challenge_emails'
>;

export function policyLimit(
  _policy: RateLimitPolicy,
  _config: AppConfig,
): number {
  throw new Error('not implemented');
}
