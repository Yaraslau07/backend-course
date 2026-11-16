import { Global, Module } from '@nestjs/common';

import { RateLimitCleanup } from './rate-limit-cleanup.service';
import { RateLimiter } from './rate-limiter.service';

/** Global: the route guard and features with custom limits (login, email challenges) inject it. */
@Global()
@Module({
  providers: [RateLimiter, RateLimitCleanup],
  exports: [RateLimiter],
})
export class RateLimitModule {}
