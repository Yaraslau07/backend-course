import { performance } from 'node:perf_hooks';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { TempArea } from '@/modules/transformations/temp-area';
import { STORAGE_MAX_ATTEMPTS } from '@/modules/transformations/transformation.types';

import { contentTypeOf } from './stored-result';

const INTERVAL_MS = 5000;
const PER_RUN = 20;
/** The wait before attempt n + 1 is 30 s × 2ⁿ, so a short outage retries soon and a long one backs off. */
const BACKOFF_SECONDS = 30;

interface PendingRow {
  id: string;
  user_id: string;
  target_format: string;
  stored_file_key: string;
  storage_attempts: number;
}

/**
 * Spec 2.4 §1.3.1 step 5: the queue is the history rows with `storage_status = 'pending'` (no task
 * table). Each pass writes the temporary copy to object storage under the key already on the row,
 * then marks the row `available` with `stored_file_until`. The row stays locked while the write runs
 * (as the photo cleanup does, D64), so an eraser or retention sweep waits for it.
 *
 * - **Repeat:** a write of a key that already holds the same bytes is `stored` again (D79), so an
 *   attempt whose commit was lost never makes a second object.
 * - **Outage:** the row stays `pending` and is due again after a growing delay. The port can't tell
 *   a temporary failure from a permanent one, so the fifth failed write turns it into `error`.
 * - **Lost copy:** a missing temporary copy is `error` at once.
 */
@Injectable()
export class TransformationStorageWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('TransformationStorage');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: ObjectStorage,
    private readonly temp: TempArea,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Tests drive `run()` themselves; isolated smoke tests turn the workers off (D53).
    if (
      this.config.get('NODE_ENV') === 'test' ||
      !this.config.get('STORAGE_WORKERS_ENABLED')
    )
      return;
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        this.logger.warn(
          { category: 'database' },
          'storage worker unavailable',
        ),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass over the due rows; returns how many it settled (written, retried or failed). */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let settled = 0;
    try {
      for (let n = 0; n < PER_RUN; n++) {
        if (!(await this.next())) break;
        settled++;
      }
      return settled;
    } finally {
      this.running = false;
    }
  }

  /** Settles the next due row; false when none is due. */
  private async next(): Promise<boolean> {
    const settled = await this.db.transaction(async (manager) => {
      const [row] = await manager.query<PendingRow[]>(
        `SELECT id, user_id, target_format, stored_file_key, storage_attempts
           FROM transformations
          WHERE storage_status = 'pending' AND storage_next_attempt_at <= clock_timestamp()
          ORDER BY storage_next_attempt_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (!row) return null;
      const started = performance.now();
      const attempts = row.storage_attempts + 1;
      const bytes = await this.temp.readPending(row.stored_file_key);
      const written = bytes
        ? await this.storage.write(
            row.stored_file_key,
            bytes,
            contentTypeOf(row.target_format),
          )
        : null;

      let result: 'available' | 'retry' | 'error';
      if (written === 'stored') {
        result = 'available';
        await manager.query(
          `UPDATE transformations
              SET storage_status = 'available', storage_attempts = $2,
                  stored_file_until = clock_timestamp() + make_interval(days => $3),
                  storage_next_attempt_at = NULL
            WHERE id = $1`,
          [
            row.id,
            attempts,
            this.config.get('TRANSFORMATION_STORED_FILE_RETENTION_DAYS'),
          ],
        );
      } else if (written === 'unavailable' && attempts < STORAGE_MAX_ATTEMPTS) {
        result = 'retry';
        await manager.query(
          `UPDATE transformations
              SET storage_attempts = $2,
                  storage_next_attempt_at = clock_timestamp() + make_interval(secs => $3)
            WHERE id = $1`,
          [row.id, attempts, BACKOFF_SECONDS * 2 ** row.storage_attempts],
        );
      } else {
        result = 'error';
        // The key stays, so cleanup can still try the object (a write may have landed unseen).
        await manager.query(
          `UPDATE transformations
              SET storage_status = 'error', storage_attempts = $2, storage_next_attempt_at = NULL
            WHERE id = $1`,
          [row.id, Math.min(attempts, STORAGE_MAX_ATTEMPTS)],
        );
      }
      this.logger.log(
        {
          event: 'transformation_storage',
          action: 'save',
          userId: row.user_id,
          transformationId: row.id,
          size: bytes?.length ?? null,
          result,
          attempts,
          durationMs: Math.round(performance.now() - started),
        },
        'transformation save attempt',
      );
      return { result, key: row.stored_file_key };
    });
    if (!settled) return false;
    // After the commit: if it had failed, the copy would still be there for the next attempt.
    if (settled.result !== 'retry')
      await this.temp.removePending(settled.key).catch(() => undefined);
    return true;
  }
}
