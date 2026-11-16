import { randomUUID } from 'node:crypto';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppConfig } from '@/core/config/config.types';
import { AppException } from '@/core/errors/app.exception';
import { rateLimitKey } from '@/core/rate-limit/rate-limit.key';
import type { RateLimitPolicyName } from '@/core/rate-limit/rate-limit.policies';
import {
  RateLimiter,
  type RateLimitResult,
} from '@/core/rate-limit/rate-limiter.service';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import { calls, RouteProbeModule } from './utils/route-probe.module';

/**
 * Rate limits are sliding windows stored in Postgres (D29): "no more than N in any window",
 * shared by every instance and kept across restarts. Keys are HMACs, never raw IPs or emails.
 */
describe('Rate limiting (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;
  let limiter: RateLimiter;
  let db: DataSource;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      imports: [RouteProbeModule],
      logs,
    }));
    limiter = app.get(RateLimiter);
    db = app.get(DataSource);
    await resetRateLimits(app);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, ['probe-user@example.com', '198.51.100.23']);
    await app.close();
  });

  /** A fresh key per test, so tests and repeated runs never share a counter. */
  const freshKey = () => [`key-${randomUUID()}`];

  /** Moves a counter's history into the past, as if `seconds` had gone by. */
  async function age(
    policy: RateLimitPolicyName,
    parts: string[],
    seconds: number,
  ) {
    await db.query(
      `UPDATE rate_limits
          SET hits = ARRAY(SELECT h - make_interval(secs => $3) FROM unnest(hits) AS h ORDER BY h),
              expires_at = expires_at - make_interval(secs => $3)
        WHERE bucket = $1 AND key = $2`,
      [
        policy,
        rateLimitKey(config.RATE_LIMIT_KEY_HMAC_KEY, policy, parts),
        seconds,
      ],
    );
  }

  async function consumeTimes(
    policy: RateLimitPolicyName,
    parts: string[],
    times: number,
  ) {
    const results: RateLimitResult[] = [];
    for (let i = 0; i < times; i++)
      results.push(await limiter.consume(policy, parts));
    return results;
  }

  describe('RateLimiter.consume()', () => {
    it('allows exactly the limit, then refuses with the seconds until a slot frees up', async () => {
      const key = freshKey();

      const results = await consumeTimes('login_ip', key, 31);

      expect(results.slice(0, 30).every((r) => r.allowed)).toBe(true);
      expect(results[30].allowed).toBe(false);
      expect(results[30].retryAfterSeconds).toBeGreaterThanOrEqual(59);
      expect(results[30].retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('is a sliding window: no burst is possible across a window boundary', async () => {
      const key = freshKey();
      await consumeTimes('login_ip', key, 30);

      // 59 seconds later all 30 hits are still inside the last minute.
      await age('login_ip', key, 59);
      expect((await limiter.consume('login_ip', key)).allowed).toBe(false);

      // 61 seconds later they have all left it.
      await age('login_ip', key, 2);
      expect((await limiter.consume('login_ip', key)).allowed).toBe(true);
    });

    it('frees slots one by one as old hits leave the window', async () => {
      const key = freshKey();
      await consumeTimes('login_ip', key, 10);
      await age('login_ip', key, 30);
      await consumeTimes('login_ip', key, 20);

      await age('login_ip', key, 31); // the first 10 are now 61 s old, the last 20 only 31 s
      const results = await consumeTimes('login_ip', key, 11);

      expect(results.filter((r) => r.allowed)).toHaveLength(10);
    });

    it('does not count refused requests', async () => {
      const key = freshKey();
      await consumeTimes('login_ip', key, 40); // 30 allowed, 10 refused

      await age('login_ip', key, 61);

      expect(
        (await consumeTimes('login_ip', key, 30)).every((r) => r.allowed),
      ).toBe(true);
    });

    it('keeps policies and keys apart', async () => {
      const key = freshKey();
      await consumeTimes('login_ip', key, 30);

      expect((await limiter.consume('refresh_ip', key)).allowed).toBe(true);
      expect((await limiter.consume('login_ip', freshKey())).allowed).toBe(
        true,
      );
    });

    it('lets exactly the limit through when requests arrive at the same time', async () => {
      const key = freshKey();

      const results = await Promise.all(
        Array.from({ length: 50 }, () => limiter.consume('login_ip', key)),
      );

      expect(results.filter((r) => r.allowed)).toHaveLength(30);
    });

    it('stores only HMACs of the keys', async () => {
      await limiter.consume('login_failures', [
        'probe-user@example.com',
        '198.51.100.23',
      ]);

      const rows = await db.query<{ key: string }[]>(
        `SELECT key FROM rate_limits WHERE bucket = 'login_failures'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const { key } of rows) {
        expect(key).toMatch(/^[0-9a-f]{64}$/);
      }
      const all = JSON.stringify(await db.query(`SELECT * FROM rate_limits`));
      expect(all).not.toContain('probe-user');
      expect(all).not.toContain('198.51.100.23');
    });
  });

  describe('peek() and record(): limits that count only failures', () => {
    it('peek reports the state without adding a hit; record adds one unconditionally', async () => {
      const key = ['probe-user@example.com', randomUUID()];

      for (let i = 0; i < 5; i++) {
        expect((await limiter.peek('login_failures', key)).allowed).toBe(true);
        await limiter.record('login_failures', key);
      }

      const state = await limiter.peek('login_failures', key);
      expect(state.allowed).toBe(false);
      expect(state.retryAfterSeconds).toBeGreaterThan(890);
      expect((await limiter.peek('login_failures', key)).allowed).toBe(false);

      await age('login_failures', key, 901);
      expect((await limiter.peek('login_failures', key)).allowed).toBe(true);
    });

    it('peek on a key never seen is allowed and creates nothing', async () => {
      const key = freshKey();

      expect(await limiter.peek('login_failures', key)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
      const [{ count }] = await db.query<{ count: string }[]>(
        `SELECT count(*) FROM rate_limits WHERE key = $1`,
        [rateLimitKey(config.RATE_LIMIT_KEY_HMAC_KEY, 'login_failures', key)],
      );
      expect(count).toBe('0');
    });
  });

  describe('enforce()', () => {
    it('throws 429 too_many_requests with retryAfterSeconds and logs the policy, not the key', async () => {
      const key = ['198.51.100.23'];
      await consumeTimes('login_ip', key, 30);
      logs.clear();

      let thrown: unknown;
      try {
        await limiter.enforce('login_ip', key);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe('too_many_requests');
      expect((thrown as AppException).extras.retryAfterSeconds).toBeGreaterThan(
        0,
      );
      expect(
        logs.lines().find((l) => l.msg === 'rate limit exceeded'),
      ).toMatchObject({
        level: 40,
        policy: 'login_ip',
      });
    });
  });

  describe('cleanup()', () => {
    it('deletes counters whose last hit has left the window, and keeps live ones', async () => {
      const old = freshKey();
      const live = freshKey();
      await limiter.consume('login_ip', old);
      await limiter.consume('login_ip', live);
      await age('login_ip', old, 120);

      const deleted = await limiter.cleanup();

      expect(deleted).toBeGreaterThanOrEqual(1);
      const remaining = await db.query<{ key: string }[]>(
        `SELECT key FROM rate_limits WHERE key = ANY($1)`,
        [
          [old, live].map((parts) =>
            rateLimitKey(config.RATE_LIMIT_KEY_HMAC_KEY, 'login_ip', parts),
          ),
        ],
      );
      expect(remaining).toEqual([
        { key: rateLimitKey(config.RATE_LIMIT_KEY_HMAC_KEY, 'login_ip', live) },
      ]);
    });
  });

  describe('on a route', () => {
    async function post(
      ip = '127.0.0.1',
      headers: Record<string, string> = {},
    ) {
      const before = calls.limited ?? 0;
      const res = await app.inject({
        method: 'POST',
        url: '/__routes/limited',
        remoteAddress: ip,
        headers,
      });
      return {
        status: res.statusCode,
        body: JSON.parse(res.body) as Record<string, unknown>,
        retryAfter: res.headers['retry-after'],
        ran: (calls.limited ?? 0) > before,
      };
    }

    beforeAll(() => resetRateLimits(app));

    it('runs the handler up to the limit, then answers 429 with Retry-After without running it', async () => {
      for (let i = 0; i < 30; i++) {
        expect(await post('192.0.2.1')).toMatchObject({
          status: 201,
          ran: true,
        });
      }

      const refused = await post('192.0.2.1');

      expect(refused).toMatchObject({ status: 429, ran: false });
      expect(refused.body).toMatchObject({
        code: 'too_many_requests',
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect(refused.retryAfter).toBe(String(refused.body.retryAfterSeconds));
    });

    it('counts each client IP separately', async () => {
      expect(await post('192.0.2.2')).toMatchObject({ status: 201, ran: true });
    });

    it('ignores X-Forwarded-For when TRUST_PROXY is off, so it cannot be used to dodge the limit', async () => {
      expect(
        await post('192.0.2.1', { 'x-forwarded-for': '203.0.113.77' }),
      ).toMatchObject({
        status: 429,
        ran: false,
      });
    });

    it('keeps counting across a restart, because the counters are in the database', async () => {
      const second = await createTestApp({ imports: [RouteProbeModule] });
      try {
        const res = await second.app.inject({
          method: 'POST',
          url: '/__routes/limited',
          remoteAddress: '192.0.2.1',
        });
        expect(res.statusCode).toBe(429);
      } finally {
        await second.app.close();
      }
    });

    it('answers a route that declares a user limit without a session with 503', async () => {
      const res = await request(app.getHttpServer()).get(
        '/__routes/user-limit-on-public',
      );

      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe(
        'authorization_unavailable',
      );
    });
  });
});
