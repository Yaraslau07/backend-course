import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

const BATCH = 500;
const MAX_BATCHES = 20;
const INTERVAL_MS = 10 * 60 * 1000;

/**
 * Spec 2.3 §1.3.5, §1.6: deletes history older than `TRANSFORMATION_HISTORY_RETENTION_DAYS`, in
 * batches of 500 through `idx_transformations_created_at`, at most 20 per sweep, every 10 minutes.
 * Spec 2.4 (C19) deletes a row's stored object before the row.
 */
@Injectable()
export class TransformationRetention implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TransformationHistory');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Tests drive `run()` themselves.
    if (this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        this.logger.warn(
          { category: 'database' },
          'history retention unavailable',
        ),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One sweep; returns how many rows it deleted. */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const [, deleted] = await this.db.query<[unknown[], number]>(
          `DELETE FROM transformations
            WHERE id IN (SELECT id FROM transformations
                          WHERE created_at < now() - make_interval(days => $1)
                          ORDER BY created_at LIMIT $2)`,
          [this.config.get('TRANSFORMATION_HISTORY_RETENTION_DAYS'), BATCH],
        );
        total += deleted;
        if (deleted < BATCH) break;
      }
      if (total > 0)
        this.logger.log(
          { event: 'transformation_retention', count: total },
          'expired history deleted',
        );
      return total;
    } finally {
      this.running = false;
    }
  }
}
