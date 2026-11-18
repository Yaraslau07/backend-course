import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ReadinessRegistry } from '@/core/health/readiness.registry';

/** What an eraser reports (spec 1.6 §1.3.5). `code` is a safe constant, never a library message. */
export type EraseResult =
  | { result: 'succeeded' }
  | { result: 'retryable_failure' | 'permanent_failure'; code: string };

/**
 * One module's part of deleting a user. Idempotent: it removes the module's PII and objects, a
 * missing object counts as success, and a second call after success succeeds again.
 */
export interface UserDataEraser {
  /** One of `USER_DATA_OWNERS`. */
  readonly owner: string;
  eraseUserData(userId: string, deletionJobId: string): Promise<EraseResult>;
}

/**
 * Every module that stores user data, in one reviewed list (spec 1.6 §1.6: readiness fails when a
 * module stores user data without an eraser). A module adds its name here when it starts keeping
 * user data, and registers its eraser in `onModuleInit`; until it does, readiness stays down.
 */
export const USER_DATA_OWNERS = ['profile', 'transformations'] as const;

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

@Injectable()
export class UserDataErasers implements OnModuleInit {
  private readonly logger = new Logger('UserDataErasers');
  private readonly erasers = new Map<string, UserDataEraser>();

  constructor(
    private readonly readiness: ReadinessRegistry,
    private readonly owners: readonly string[] = USER_DATA_OWNERS,
  ) {}

  onModuleInit(): void {
    this.readiness.register('user_data_erasers', () =>
      Promise.resolve(
        this.missing().length === 0 ? 'up' : { down: 'eraser_missing' },
      ),
    );
  }

  register(eraser: UserDataEraser): void {
    if (this.erasers.has(eraser.owner)) {
      throw new Error(`An eraser for "${eraser.owner}" is already registered`);
    }
    this.erasers.set(eraser.owner, eraser);
  }

  /** Declared owners without an eraser. */
  missing(): string[] {
    return this.owners.filter((owner) => !this.erasers.has(owner));
  }

  /**
   * Runs every eraser in registration order and stops at the first failure: the job is retried as a
   * whole, and each eraser is idempotent. A thrown error is a retryable failure with a fixed code.
   */
  async eraseAll(userId: string, deletionJobId: string): Promise<EraseResult> {
    if (this.missing().length > 0)
      return { result: 'retryable_failure', code: 'eraser_missing' };
    for (const eraser of this.erasers.values()) {
      let outcome: EraseResult;
      try {
        outcome = await eraser.eraseUserData(userId, deletionJobId);
      } catch (error) {
        this.logger.warn(
          {
            event: 'eraser',
            owner: eraser.owner,
            result: 'error',
            category: error instanceof Error ? error.name : 'unknown',
          },
          'eraser threw',
        );
        outcome = { result: 'retryable_failure', code: 'eraser_error' };
      }
      if (outcome.result !== 'succeeded') {
        return {
          result: outcome.result,
          code: SAFE_CODE.test(outcome.code) ? outcome.code : 'eraser_failed',
        };
      }
    }
    return { result: 'succeeded' };
  }
}
