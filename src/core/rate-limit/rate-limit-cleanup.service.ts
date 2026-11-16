import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { RateLimiter } from './rate-limiter.service';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Deletes expired counters every 5 minutes. Running it on every instance at once is harmless:
 * each DELETE removes rows nobody needs. The timer doesn't keep the process alive.
 */
@Injectable()
export class RateLimitCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  private timer?: NodeJS.Timeout;

  constructor(private readonly limiter: RateLimiter) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async run(): Promise<void> {
    try {
      const deleted = await this.limiter.cleanup();
      if (deleted > 0)
        this.logger.log({ deleted }, 'expired rate-limit counters deleted');
    } catch (error) {
      this.logger.warn(
        { errorType: (error as Error)?.name ?? 'error' },
        'rate-limit cleanup failed',
      );
    }
  }
}
