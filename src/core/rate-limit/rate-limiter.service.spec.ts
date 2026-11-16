import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { RateLimitCleanup } from './rate-limit-cleanup.service';
import { rateLimitKey } from './rate-limit.key';
import { RateLimiter } from './rate-limiter.service';

const SECRET = Buffer.alloc(32, 3).toString('base64url');

/** The SQL itself runs against Postgres in test/rate-limit.e2e-spec.ts; this checks the glue. */
function limiterWith(rows: unknown) {
  const query = jest
    .fn<Promise<unknown>, [string, unknown[]]>()
    .mockResolvedValue(rows);
  const db = { query } as unknown as DataSource;
  const config = {
    get: (key: string) =>
      ({
        RATE_LIMIT_KEY_HMAC_KEY: SECRET,
        REGISTRATION_RATE_LIMIT_PER_HOUR: 7,
      })[key],
  } as unknown as ConfigService;
  return { limiter: new RateLimiter(db, config), query };
}

describe('RateLimiter', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('passes the policy, the hashed key, the limit and the window', async () => {
    const { limiter, query } = limiterWith([{ allowed: true, retry_after: 0 }]);

    await limiter.consume('registration_ip', ['203.0.113.9']);

    expect(query.mock.calls[0][1]).toEqual([
      'registration_ip',
      rateLimitKey(SECRET, 'registration_ip', ['203.0.113.9']),
      7,
      3600,
    ]);
  });

  it('reports retryAfterSeconds as a number', async () => {
    const { limiter } = limiterWith([{ allowed: false, retry_after: '42' }]);

    expect(await limiter.consume('login_ip', ['x'])).toEqual({
      allowed: false,
      retryAfterSeconds: 42,
    });
  });

  it('peek on a missing row is allowed', async () => {
    const { limiter } = limiterWith([]);

    expect(await limiter.peek('login_failures', ['x'])).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('enforce throws 429 with retryAfterSeconds when refused, and passes otherwise', async () => {
    await expect(
      limiterWith([{ allowed: true, retry_after: 0 }]).limiter.enforce(
        'login_ip',
        ['x'],
      ),
    ).resolves.toBeUndefined();

    const refused = limiterWith([
      { allowed: false, retry_after: 9 },
    ]).limiter.enforce('login_ip', ['x']);
    await expect(refused).rejects.toBeInstanceOf(AppException);
    await expect(refused).rejects.toMatchObject({
      code: 'too_many_requests',
      extras: { retryAfterSeconds: 9 },
    });
  });

  it('cleanup keeps deleting while full batches come back', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 1000])
      .mockResolvedValueOnce([[], 3]);
    const limiter = new RateLimiter(
      { query } as unknown as DataSource,
      { get: () => SECRET } as unknown as ConfigService,
    );

    expect(await limiter.cleanup()).toBe(1003);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('RateLimitCleanup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('runs every 5 minutes until the module is destroyed', async () => {
    jest.useFakeTimers();
    const cleanup = jest.fn().mockResolvedValue(0);
    const service = new RateLimitCleanup({ cleanup } as unknown as RateLimiter);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('logs what it deleted, and a failure without throwing', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await new RateLimitCleanup({
      cleanup: jest.fn().mockResolvedValue(4),
    } as unknown as RateLimiter).run();
    await new RateLimitCleanup({
      cleanup: jest.fn().mockRejectedValue(new TypeError('db down')),
    } as unknown as RateLimiter).run();

    expect(log).toHaveBeenCalledWith(
      { deleted: 4 },
      'expired rate-limit counters deleted',
    );
    expect(warn).toHaveBeenCalledWith(
      { errorType: 'TypeError' },
      'rate-limit cleanup failed',
    );
  });
});
