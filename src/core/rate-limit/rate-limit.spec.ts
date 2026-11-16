/* eslint-disable @typescript-eslint/unbound-method -- handlers are read as metadata targets, never called */
import { Controller, Get } from '@nestjs/common';

import type { AppConfig } from '@/core/config/config.types';

import { getRouteRateLimits, RateLimit } from './rate-limit.decorator';
import {
  type ConfigGetter,
  policyLimit,
  RATE_LIMIT_POLICIES,
  type RateLimitName,
} from './rate-limit.policies';
import { rateLimitKey } from './rate-limit.key';

const SECRET = Buffer.alloc(32, 9).toString('base64url');

/** A config accessor that knows only the registration limit. */
const getter =
  (perHour: number): ConfigGetter =>
  <K extends keyof AppConfig>(key: K) =>
    ({ REGISTRATION_RATE_LIMIT_PER_HOUR: perHour })[
      key as 'REGISTRATION_RATE_LIMIT_PER_HOUR'
    ] as AppConfig[K];

describe('RATE_LIMIT_POLICIES', () => {
  it('matches the numbers in the specs', () => {
    const table = Object.fromEntries(
      Object.entries(RATE_LIMIT_POLICIES).map(([name, policy]) => [
        name,
        [policyLimit(policy, getter(10)), policy.windowSeconds, policy.by],
      ]),
    );

    expect(table).toEqual({
      registration_ip: [10, 3600, 'ip'],
      registration_resend_ip: [10, 3600, 'ip'],
      login_ip: [30, 60, 'ip'],
      login_failures: [5, 900, 'custom'],
      refresh_ip: [30, 60, 'ip'],
      profile_read_self: [120, 60, 'custom'],
      profile_read_foreign: [60, 60, 'custom'],
      user_update: [30, 3600, 'user'],
      email_change_emails: [5, 3600, 'custom'],
      deletion_challenge_emails: [5, 3600, 'custom'],
      deletion_status_ip: [60, 60, 'ip'],
      users_list_user: [60, 60, 'user'],
      users_list_ip: [120, 60, 'ip'],
      history_user: [60, 60, 'user'],
    });
  });

  it('cites the spec section of every policy', () => {
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      expect(policy.spec).toMatch(/^\d\.\d §1\.\d/);
    }
  });

  it('takes the registration limit from REGISTRATION_RATE_LIMIT_PER_HOUR', () => {
    expect(policyLimit(RATE_LIMIT_POLICIES.registration_ip, getter(3))).toBe(3);
  });
});

describe('rateLimitKey()', () => {
  it('is a stable 64-character hex HMAC that contains none of its inputs', () => {
    const key = rateLimitKey(SECRET, 'login_failures', [
      'user@example.com',
      '203.0.113.9',
    ]);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(
      rateLimitKey(SECRET, 'login_failures', [
        'user@example.com',
        '203.0.113.9',
      ]),
    ).toBe(key);
    expect(key).not.toContain('example');
  });

  it('differs per policy, per value and per key', () => {
    const base = rateLimitKey(SECRET, 'login_ip', ['203.0.113.9']);

    expect(rateLimitKey(SECRET, 'refresh_ip', ['203.0.113.9'])).not.toBe(base);
    expect(rateLimitKey(SECRET, 'login_ip', ['203.0.113.10'])).not.toBe(base);
    expect(
      rateLimitKey(Buffer.alloc(32, 8).toString('base64url'), 'login_ip', [
        '203.0.113.9',
      ]),
    ).not.toBe(base);
  });

  it('cannot be confused by moving a separator between parts', () => {
    expect(rateLimitKey(SECRET, 'login_failures', ['a|b', 'c'])).not.toBe(
      rateLimitKey(SECRET, 'login_failures', ['a', 'b|c']),
    );
  });
});

describe('@RateLimit()', () => {
  @Controller()
  class Things {
    @Get('a')
    @RateLimit('login_ip', 'users_list_user')
    a() {}

    @Get('b')
    b() {}
  }

  it('records the route policies, split into IP- and user-keyed ones', () => {
    expect(getRouteRateLimits(Things.prototype.a)).toEqual({
      ip: ['login_ip'],
      user: ['users_list_user'],
    });
    expect(getRouteRateLimits(Things.prototype.b)).toEqual({
      ip: [],
      user: [],
    });
  });

  it('only accepts IP- or user-keyed policies (custom ones are applied in code)', () => {
    // @ts-expect-error: login_failures is keyed by email and IP, so a route can't declare it.
    const custom: RateLimitName = 'login_failures';
    expect(RATE_LIMIT_POLICIES[custom].by).toBe('custom');
  });
});
