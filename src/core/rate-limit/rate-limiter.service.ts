import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { rateLimitKey } from './rate-limit.key';
import {
  policyLimit,
  RATE_LIMIT_POLICIES,
  type RateLimitPolicyName,
} from './rate-limit.policies';

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed; otherwise whole seconds until the oldest hit leaves the window. */
  retryAfterSeconds: number;
}

const CLEANUP_BATCH = 1000;

/**
 * The hits of the existing row still inside the window, oldest first, capped at the newest $3.
 * $3 is the limit, $4 the window in seconds.
 */
const LIVE_HITS = `ARRAY(
  SELECT h FROM (
    SELECT h FROM unnest(r.hits) AS h
     WHERE h > now() - make_interval(secs => $4)
     ORDER BY h DESC
     LIMIT $3
  ) AS newest ORDER BY h
)`;

const RETRY_AFTER = `GREATEST(1, ceil(extract(epoch FROM (hits[1] + make_interval(secs => $4) - now()))))::int`;

interface Row {
  allowed: boolean;
  retry_after: number | string;
}

/**
 * Sliding-window rate limits in Postgres (D29): every instance shares the counters, and they
 * survive restarts. Each operation is a single statement, so concurrent requests on the same
 * key are serialized by the row lock and exactly `limit` get through.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger('RateLimit');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * Counts a hit if there is room; refused requests are not counted. Pruning, the check and the
   * append happen in one statement on the locked row, from a single evaluation of the live hits.
   */
  async consume(
    policy: RateLimitPolicyName,
    parts: string[],
    manager: Pick<EntityManager, 'query'> = this.db,
  ): Promise<RateLimitResult> {
    const rows = await manager.query<Row[]>(
      `INSERT INTO rate_limits AS r (bucket, key, hits, last_allowed, expires_at)
       VALUES ($1, $2, ARRAY[now()], true, now() + make_interval(secs => $4))
       ON CONFLICT (bucket, key) DO UPDATE SET (last_allowed, hits, expires_at) = (
         SELECT cardinality(live) < $3,
                CASE WHEN cardinality(live) < $3 THEN live || now() ELSE live END,
                -- When the newest stored hit leaves the window; a refusal adds no hit.
                CASE WHEN cardinality(live) < $3 THEN now() ELSE live[cardinality(live)] END
                  + make_interval(secs => $4)
           FROM (SELECT ${LIVE_HITS} AS live) AS current
       )
       RETURNING last_allowed AS allowed,
                 CASE WHEN last_allowed THEN 0 ELSE ${RETRY_AFTER} END AS retry_after`.replaceAll(
        'now()',
        manager === this.db ? 'now()' : 'statement_timestamp()',
      ),
      this.params(policy, parts),
    );
    return this.result(rows[0]);
  }

  /** Whether a hit would be allowed now, without counting one. */
  async peek(
    policy: RateLimitPolicyName,
    parts: string[],
  ): Promise<RateLimitResult> {
    const rows = await this.db.query<Row[]>(
      `SELECT cardinality(hits) < $3 AS allowed,
              CASE WHEN cardinality(hits) < $3 THEN 0 ELSE ${RETRY_AFTER} END AS retry_after
         FROM (SELECT ${LIVE_HITS} AS hits FROM rate_limits AS r
                WHERE r.bucket = $1 AND r.key = $2) AS live`,
      this.params(policy, parts),
    );
    return rows.length === 0
      ? { allowed: true, retryAfterSeconds: 0 }
      : this.result(rows[0]);
  }

  /**
   * Gives back one hit taken by `consume()`. For limits that count only failures (5 failed logins
   * per email and IP): consume before the password check, which is atomic, so concurrent attempts
   * can't all slip past the limit; release after a success (D32).
   */
  async release(policy: RateLimitPolicyName, parts: string[]): Promise<void> {
    await this.db.query(
      `UPDATE rate_limits
          SET hits = hits[1:cardinality(hits) - 1]
        WHERE bucket = $1 AND key = $2 AND cardinality(hits) > 0`,
      this.params(policy, parts).slice(0, 2),
    );
  }

  /** `consume()`, throwing `429 too_many_requests` with `retryAfterSeconds` when refused. */
  async enforce(policy: RateLimitPolicyName, parts: string[]): Promise<void> {
    const result = await this.consume(policy, parts);
    if (result.allowed) return;
    this.logger.warn(
      { policy, retryAfterSeconds: result.retryAfterSeconds },
      'rate limit exceeded',
    );
    throw new AppException('too_many_requests', {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }

  /** Deletes counters whose newest hit has left the window, in small batches. */
  async cleanup(): Promise<number> {
    let total = 0;
    for (;;) {
      const [, affected] = await this.db.query<[unknown, number]>(
        `DELETE FROM rate_limits
          WHERE ctid IN (SELECT ctid FROM rate_limits WHERE expires_at < now() LIMIT $1)`,
        [CLEANUP_BATCH],
      );
      total += affected;
      if (affected < CLEANUP_BATCH) return total;
    }
  }

  private params(policy: RateLimitPolicyName, parts: string[]): unknown[] {
    const definition = RATE_LIMIT_POLICIES[policy];
    return [
      policy,
      rateLimitKey(this.config.get('RATE_LIMIT_KEY_HMAC_KEY'), policy, parts),
      policyLimit(definition, (key) => this.config.get(key)),
      definition.windowSeconds,
    ];
  }

  private result(row: Row): RateLimitResult {
    return { allowed: row.allowed, retryAfterSeconds: Number(row.retry_after) };
  }
}
