import type { AppConfig } from '@/core/config/config.types';

/** The typed config accessor (`ConfigService.get`), so a policy can read its limit from config. */
export type ConfigGetter = <K extends keyof AppConfig>(key: K) => AppConfig[K];

export interface RateLimitPolicy {
  /**
   * What the counter is keyed by. `ip` and `user` policies are declared on routes with
   * `@RateLimit()` and applied by the route guard; `custom` ones are applied in code, because
   * their key or their moment needs the handler (email + IP with release on success, emails sent, self vs foreign).
   */
  by: 'ip' | 'user' | 'custom';
  /** At most this many hits in any window of `windowSeconds` (a sliding window, D29). */
  limit: number | ((get: ConfigGetter) => number);
  windowSeconds: number;
  /** Where the number comes from. */
  spec: string;
}

/** Every rate limit in the specs, in one place. Features use these names; nobody invents a number. */
export const RATE_LIMIT_POLICIES = {
  registration_ip: {
    by: 'ip',
    limit: (get) => get('REGISTRATION_RATE_LIMIT_PER_HOUR'),
    windowSeconds: 3600,
    spec: '1.0 §1.6: rate limit for registration, threshold from config',
  },
  registration_resend_ip: {
    by: 'ip',
    limit: (get) => get('REGISTRATION_RATE_LIMIT_PER_HOUR'),
    windowSeconds: 3600,
    spec: '1.0 §1.6: and for resending (same threshold, D30)',
  },
  login_ip: {
    by: 'ip',
    limit: 30,
    windowSeconds: 60,
    spec: '1.2 §1.6: login, 30 requests per IP per minute',
  },
  login_failures: {
    by: 'custom',
    limit: 5,
    windowSeconds: 900,
    spec: '1.2 §1.6: 5 failed checks per email and IP in 15 minutes',
  },
  refresh_ip: {
    by: 'ip',
    limit: 30,
    windowSeconds: 60,
    spec: '1.2 §1.6: refresh, 30 requests per IP per minute',
  },
  profile_read_self: {
    by: 'custom',
    limit: 120,
    windowSeconds: 60,
    spec: '1.4 §1.6: own profile and photo, 120 per user per minute',
  },
  profile_read_foreign: {
    by: 'custom',
    limit: 60,
    windowSeconds: 60,
    spec: "1.4 §1.6: someone else's profile and photo, 60 per user per minute",
  },
  user_update: {
    by: 'user',
    limit: 30,
    windowSeconds: 3600,
    spec: '1.5 §1.6: PATCH and photo operations, 30 per user per hour',
  },
  email_change_emails: {
    by: 'custom',
    limit: 5,
    windowSeconds: 3600,
    spec: '1.5 §1.6: email-change emails, 5 per user per hour',
  },
  deletion_challenge_emails: {
    by: 'custom',
    limit: 5,
    windowSeconds: 3600,
    spec: '1.6 §1.6: deletion-challenge emails, 5 per user per hour',
  },
  deletion_status_ip: {
    by: 'ip',
    limit: 60,
    windowSeconds: 60,
    spec: '1.6 §1.6: deletion status, 60 per IP per minute',
  },
  users_list_user: {
    by: 'user',
    limit: 60,
    windowSeconds: 60,
    spec: '1.7 §1.6: user list, 60 per actor per minute',
  },
  users_list_ip: {
    by: 'ip',
    limit: 120,
    windowSeconds: 60,
    spec: '1.7 §1.6: and 120 per IP per minute',
  },
  history_user: {
    by: 'user',
    limit: 60,
    windowSeconds: 60,
    spec: '2.3 §1.6: history reads, 60 per user per minute',
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** The policies a route may declare with `@RateLimit()`: keyed by IP or by the signed-in user. */
export type RateLimitName = {
  [K in RateLimitPolicyName]: (typeof RATE_LIMIT_POLICIES)[K]['by'] extends 'custom'
    ? never
    : K;
}[RateLimitPolicyName];

export function policyLimit(
  policy: RateLimitPolicy,
  get: ConfigGetter,
): number {
  return typeof policy.limit === 'function' ? policy.limit(get) : policy.limit;
}
