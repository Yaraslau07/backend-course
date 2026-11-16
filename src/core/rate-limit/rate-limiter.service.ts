/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import { Injectable } from '@nestjs/common';

import type { RateLimitPolicyName } from './rate-limit.policies';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimiter {
  consume(
    _policy: RateLimitPolicyName,
    _parts: string[],
  ): Promise<RateLimitResult> {
    throw new Error('not implemented');
  }

  peek(
    _policy: RateLimitPolicyName,
    _parts: string[],
  ): Promise<RateLimitResult> {
    throw new Error('not implemented');
  }

  record(_policy: RateLimitPolicyName, _parts: string[]): Promise<void> {
    throw new Error('not implemented');
  }

  enforce(_policy: RateLimitPolicyName, _parts: string[]): Promise<void> {
    throw new Error('not implemented');
  }

  cleanup(): Promise<number> {
    throw new Error('not implemented');
  }
}
