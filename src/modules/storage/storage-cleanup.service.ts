import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@/core/config/config.service';
import { ObjectStorage, STORAGE_ADOPTION_LOCK } from './object-storage';

@Injectable()
export class StorageCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StorageCleanup');
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private sweeping = false;
  private sweepCursor?: string;
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService,
  ) {}
  onModuleInit(): void {
    if (
      this.config.get('NODE_ENV') === 'test' ||
      !this.config.get('STORAGE_WORKERS_ENABLED')
    )
      return;
    this.timers = [
      setInterval(() => {
        void this.run().catch(() =>
          this.logger.warn(
            { category: 'database' },
            'storage cleanup unavailable',
          ),
        );
      }, 5000),
      setInterval(
        () => {
          void this.sweep().catch(() =>
            this.logger.warn(
              { category: 'reconciliation' },
              'storage reconciliation unavailable',
            ),
          );
        },
        5 * 60 * 1000,
      ),
    ];
    this.timers.forEach((t) => t.unref());
  }
  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
  }
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      await this.db.query(
        `UPDATE storage_cleanup_jobs SET status = 'failed', next_attempt_at = NULL, last_error_code = 'attempts_exhausted', updated_at = clock_timestamp() WHERE status = 'queued' AND attempts >= 5`,
      );
      for (let n = 0; n < 20; n++) {
        const found = await this.db.transaction(async (manager) => {
          const [job] = await manager.query<
            { id: string; storage_key: string; attempts: number }[]
          >(
            `SELECT id, storage_key, attempts FROM storage_cleanup_jobs WHERE status = 'queued' AND next_attempt_at <= clock_timestamp() AND attempts < 5 ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          );
          if (!job) return false;
          const [reference] = await manager.query<{ present: number }[]>(
            `SELECT 1 FROM users WHERE photo_key = $1 LIMIT 1`,
            [job.storage_key],
          );
          const result = reference
            ? 'referenced'
            : await this.storage.delete(job.storage_key);
          const success = result === 'deleted' || result === 'not_found';
          const status = success
            ? 'succeeded'
            : result === 'referenced' || job.attempts + 1 >= 5
              ? 'failed'
              : 'queued';
          await manager.query(
            `UPDATE storage_cleanup_jobs SET attempts = attempts + 1, status = $2::storage_cleanup_status, next_attempt_at = CASE WHEN $2::storage_cleanup_status = 'queued' THEN clock_timestamp() + interval '1 minute' END, last_error_code = $3, updated_at = clock_timestamp() WHERE id = $1`,
            [
              job.id,
              status,
              success
                ? null
                : result === 'referenced'
                  ? 'still_referenced'
                  : 'storage_unavailable',
            ],
          );
          this.logger.log(
            {
              event: 'storage_cleanup',
              jobId: job.id,
              result: status,
              attempts: job.attempts + 1,
            },
            'storage cleanup attempt',
          );
          return true;
        });
        if (!found) break;
        processed++;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      return await this.db.transaction(async (manager) => {
        const [{ locked }] = await manager.query<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock($1) AS locked`,
          [STORAGE_ADOPTION_LOCK],
        );
        if (!locked) return 0;
        const [{ cutoff }] = await manager.query<{ cutoff: Date }[]>(
          `SELECT clock_timestamp() - interval '1 hour' AS cutoff`,
        );
        let cursor = this.sweepCursor;
        let deleted = 0;
        const deadline = performance.now() + 10_000;
        for (
          let page = 0;
          page < 10 && deleted < 20 && performance.now() < deadline;
          page++
        ) {
          const listing = await this.storage.list(cursor);
          if (listing.kind !== 'listed') {
            this.logger.warn(
              { category: 'storage' },
              'orphan listing unavailable',
            );
            break;
          }
          const candidates = listing.objects.filter(
            (o) => o.modifiedAt < cutoff && /^[0-9a-f-]{36}\.webp$/.test(o.key),
          );
          const references = await manager.query<{ photo_key: string }[]>(
            `SELECT photo_key FROM users WHERE photo_key = ANY($1::text[])`,
            [candidates.map((o) => o.key)],
          );
          const protectedKeys = new Set(references.map((r) => r.photo_key));
          for (const object of candidates) {
            if (performance.now() >= deadline) break;
            if (protectedKeys.has(object.key)) continue;
            const result = await this.storage.delete(object.key);
            if (result === 'unavailable') {
              this.sweepCursor = cursor;
              this.logger.warn(
                { category: 'storage' },
                'orphan deletion unavailable',
              );
              return deleted;
            }
            if (result === 'deleted' || result === 'not_found') deleted++;
            if (deleted >= 20) break;
          }
          this.sweepCursor = listing.cursor;
          if (!listing.cursor || listing.cursor === cursor) break;
          cursor = listing.cursor;
        }
        if (deleted)
          this.logger.log(
            { event: 'storage_reconciliation', deleted },
            'unreferenced old objects removed',
          );
        return deleted;
      });
    } finally {
      this.sweeping = false;
    }
  }
}
