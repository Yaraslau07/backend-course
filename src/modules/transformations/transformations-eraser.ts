import { performance } from 'node:perf_hooks';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type {
  EraseResult,
  UserDataEraser,
} from '@/modules/erasure/user-data-erasers';
import { ObjectStorage } from '@/modules/storage/object-storage';

import { TempArea } from './temp-area';

const BATCH = 100;

/**
 * Spec 2.0 §1.3.4, 1.6 §1.3.5 and 2.4 §1.3.5: the user's history rows in small batches, each row's
 * stored object deleted before the row (a missing object counts as deleted), and its temporary copy
 * with it. The batch's rows are locked first, so a worker mid-write finishes before its row goes, and
 * its object is then deleted here. If storage is unavailable the rows stay and the job is retried.
 */
@Injectable()
export class TransformationsEraser implements UserDataEraser {
  readonly owner = 'transformations';
  private readonly logger = new Logger('TransformationStorage');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: ObjectStorage,
    private readonly temp: TempArea,
  ) {}

  async eraseUserData(userId: string): Promise<EraseResult> {
    try {
      for (;;) {
        const outcome = await this.batch(userId);
        if (outcome === 'unavailable')
          return { result: 'retryable_failure', code: 'storage_unavailable' };
        if (outcome < BATCH) return { result: 'succeeded' };
      }
    } catch {
      return { result: 'retryable_failure', code: 'history_unavailable' };
    }
  }

  /** Rows deleted in this batch, or 'unavailable' when an object couldn't be deleted. */
  private async batch(userId: string): Promise<number | 'unavailable'> {
    const keys: string[] = [];
    const outcome = await this.db.transaction(async (manager) => {
      const rows = await manager.query<
        { id: string; stored_file_key: string | null }[]
      >(
        `SELECT id, stored_file_key FROM transformations
          WHERE user_id = $1 ORDER BY id LIMIT $2 FOR UPDATE`,
        [userId, BATCH],
      );
      const gone: string[] = [];
      for (const row of rows) {
        if (row.stored_file_key) {
          const started = performance.now();
          const result = await this.storage.delete(row.stored_file_key);
          const ok = result === 'deleted' || result === 'not_found';
          this.logger.log(
            {
              event: 'transformation_storage',
              action: 'delete',
              userId,
              transformationId: row.id,
              result: ok ? result : 'storage_unavailable',
              durationMs: Math.round(performance.now() - started),
            },
            'transformation delete',
          );
          if (!ok) continue;
          keys.push(row.stored_file_key);
        }
        gone.push(row.id);
      }
      if (gone.length > 0)
        await manager.query(
          `DELETE FROM transformations WHERE id = ANY($1::uuid[])`,
          [gone],
        );
      return gone.length < rows.length ? 'unavailable' : rows.length;
    });
    for (const key of keys)
      await this.temp.removePending(key).catch(() => undefined);
    return outcome;
  }
}
