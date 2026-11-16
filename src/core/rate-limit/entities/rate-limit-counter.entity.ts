import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { timestamp } from '../../../database/columns';

/**
 * One sliding-window counter per policy and key (D29). `hits` holds the times of the allowed
 * requests still inside the window, oldest first, at most `limit` of them; older ones are
 * dropped on every write. Rows are written with raw SQL in `RateLimiter`, in one statement each.
 */
@Entity('rate_limits')
@Index('idx_rate_limits_expires_at', ['expiresAt'])
@Check('ck_rate_limits_key', `"key" ~ '^[0-9a-f]{64}$'`)
export class RateLimitCounter {
  /** The policy name, for example `login_ip`. */
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'pk_rate_limits' })
  bucket: string;

  /** HMAC of the key parts (D31); never a raw IP, email or id. */
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'pk_rate_limits' })
  key: string;

  /**
   * Plain `timestamptz[]`: TypeORM can't read the precision of an array column back, so
   * `timestamptz(3)[]` would show as drift forever. These values never leave the database,
   * so the millisecond rule of D12 doesn't apply to them.
   */
  @Column({ type: 'timestamptz', array: true })
  hits: Date[];

  /** Whether the latest consume was allowed; lets one statement both decide and report. */
  @Column({ name: 'last_allowed', type: 'boolean' })
  lastAllowed: boolean;

  /** When the newest hit leaves the window; cleanup deletes rows past it. */
  @Column(timestamp('expires_at'))
  expiresAt: Date;
}
