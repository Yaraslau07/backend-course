import { performance } from 'node:perf_hooks';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { TempArea } from '@/modules/transformations/temp-area';

const BATCH = 500;
/** Stored objects are deleted over the network, so their batches are smaller (spec 2.4 §1.3.5). */
const OBJECT_BATCH = 50;
const MAX_BATCHES = 20;
const INTERVAL_MS = 10 * 60 * 1000;

interface Candidate {
  id: string;
  user_id: string;
  stored_file_key: string | null;
}

/**
 * Spec 2.3 §1.3.5, §1.6 and spec 2.4 §1.3.5: one sweep, every 10 minutes, in small batches.
 * 1. **Expired files:** a stored file past `stored_file_until` is deleted from storage and its
 *    storage fields cleared; the history row stays (D79).
 * 2. **Old rows:** history older than `TRANSFORMATION_HISTORY_RETENTION_DAYS` goes through
 *    `idx_transformations_created_at`, and a row's object is deleted *before* the row. `not_found`
 *    is a success; if storage is unavailable the row stays for the next sweep.
 */
@Injectable()
export class TransformationRetention implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TransformationHistory');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly storage: ObjectStorage,
    private readonly temp: TempArea,
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

  /** One sweep; returns how many rows it deleted (expired files cleared are logged separately). */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const expired = await this.expireFiles();
      const total = await this.deleteOldRows();
      if (total > 0)
        this.logger.log(
          { event: 'transformation_retention', count: total },
          'expired history deleted',
        );
      if (expired > 0)
        this.logger.log(
          { event: 'transformation_retention', files: expired },
          'expired stored files deleted',
        );
      return total;
    } finally {
      this.running = false;
    }
  }

  private async expireFiles(): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const cleared = await this.db.transaction(async (manager) => {
        const rows = await manager.query<Candidate[]>(
          `SELECT id, user_id, stored_file_key FROM transformations
            WHERE storage_status = 'available' AND stored_file_until < clock_timestamp()
            ORDER BY stored_file_until LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [OBJECT_BATCH],
        );
        const done = await this.deleteObjects(rows);
        if (done.length > 0)
          await manager.query(
            `UPDATE transformations
                SET storage_status = 'not_requested', stored_file_key = NULL,
                    stored_file_until = NULL, storage_attempts = 0
              WHERE id = ANY($1::uuid[])`,
            [done.map((row) => row.id)],
          );
        return { count: done.length, full: done.length === rows.length };
      });
      total += cleared.count;
      // An unavailable store ends the pass: the same rows would only fail again.
      if (!cleared.full || cleared.count < OBJECT_BATCH) break;
    }
    return total;
  }

  private async deleteOldRows(): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const outcome = await this.db.transaction(async (manager) => {
        const rows = await manager.query<Candidate[]>(
          `SELECT id, user_id, stored_file_key FROM transformations
            WHERE created_at < now() - make_interval(days => $1)
            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [this.config.get('TRANSFORMATION_HISTORY_RETENTION_DAYS'), BATCH],
        );
        const withObjects = rows.filter((row) => row.stored_file_key);
        const deletable = new Set(
          (await this.deleteObjects(withObjects)).map((row) => row.id),
        );
        const ids = rows
          .filter((row) => !row.stored_file_key || deletable.has(row.id))
          .map((row) => row.id);
        await this.deleteRows(manager, ids);
        return { rows, ids, withObjects };
      });
      for (const row of outcome.withObjects)
        if (row.stored_file_key)
          await this.temp
            .removePending(row.stored_file_key)
            .catch(() => undefined);
      total += outcome.ids.length;
      // A short batch is the end; so is a batch whose object deletions failed.
      if (
        outcome.rows.length < BATCH ||
        outcome.ids.length < outcome.rows.length
      )
        break;
    }
    return total;
  }

  private async deleteRows(manager: EntityManager, ids: string[]) {
    if (ids.length > 0)
      await manager.query(
        `DELETE FROM transformations WHERE id = ANY($1::uuid[])`,
        [ids],
      );
  }

  /** Deletes each row's object; returns the rows whose object is gone (`not_found` counts). */
  private async deleteObjects(rows: Candidate[]): Promise<Candidate[]> {
    const done: Candidate[] = [];
    for (const row of rows) {
      if (!row.stored_file_key) continue;
      const started = performance.now();
      const result = await this.storage.delete(row.stored_file_key);
      const ok = result === 'deleted' || result === 'not_found';
      this.logger.log(
        {
          event: 'transformation_storage',
          action: 'delete',
          userId: row.user_id,
          transformationId: row.id,
          result: ok ? result : 'storage_unavailable',
          durationMs: Math.round(performance.now() - started),
        },
        'transformation delete',
      );
      if (ok) done.push(row);
    }
    return done;
  }
}
