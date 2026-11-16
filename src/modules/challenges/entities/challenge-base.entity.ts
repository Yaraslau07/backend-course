import { Check, Column, Entity, ForeignKey, Index } from 'typeorm';

import { timestamp, timestampNow } from '../../../database/columns';

import { User } from '../../users/entities/user.entity';

import {
  CHALLENGE_CONSUMED_REASONS,
  CHALLENGE_METHODS,
  type ChallengeConsumedReason,
  type ChallengeMethod,
} from '../challenges.types';

/**
 * Columns shared by the four email-challenge tables (registration, login, email change, deletion).
 * They are separate tables, not one table with a `scenario` column, because each scenario has its
 * own HMAC key and its own "one outstanding challenge per user" rule, and the specs name them separately.
 *
 * The primary key is declared in each subclass: a constraint name must be unique in the schema.
 */
export abstract class ChallengeBase {
  abstract id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Chosen by the server when the challenge is created; a later config change doesn't alter it. */
  @Column({
    type: 'enum',
    enum: CHALLENGE_METHODS,
    enumName: 'challenge_method',
  })
  method: ChallengeMethod;

  /** HMAC-SHA256 of the OTP or token under the scenario's key. The secret itself is never stored. */
  @Column({ name: 'secret_hash', type: 'bytea' })
  secretHash: Buffer;

  /** Wrong OTP entries since the last send. Magic links don't count attempts. */
  @Column({ type: 'smallint', default: 0 })
  attempts: number;

  /** The TTL (10 min) and the resend cooldown (60 s) are both measured from here. */
  @Column(timestampNow('last_sent_at'))
  lastSentAt: Date;

  @Column(timestamp('consumed_at', { nullable: true }))
  consumedAt: Date | null;

  @Column({
    name: 'consumed_reason',
    type: 'enum',
    enum: CHALLENGE_CONSUMED_REASONS,
    enumName: 'challenge_consumed_reason',
    nullable: true,
  })
  consumedReason: ChallengeConsumedReason | null;

  @Column(timestampNow('created_at'))
  createdAt: Date;
}

/** `@Entity` plus the constraints every challenge table has, named after the table. */
export function ChallengeEntity(table: string): ClassDecorator {
  const decorators: ClassDecorator[] = [
    Entity(table),
    // One outstanding challenge per user: a concurrent second insert fails instead of racing.
    Index(`uq_${table}_outstanding`, ['userId'], {
      unique: true,
      where: `"consumed_at" IS NULL`,
    }),
    // Consumed rows aren't in the partial index; anonymization deletes all of a user's challenges.
    Index(`idx_${table}_user`, ['userId']),
    Check(`ck_${table}_attempts`, `"attempts" BETWEEN 0 AND 5`),
    Check(
      `ck_${table}_consumed`,
      `("consumed_at" IS NULL) = ("consumed_reason" IS NULL)`,
    ),
    Check(`ck_${table}_secret_hash`, `octet_length("secret_hash") = 32`),
    ForeignKey(() => User, ['userId'], ['id'], { name: `fk_${table}_user` }),
  ];
  return (target) => decorators.forEach((decorate) => decorate(target));
}
