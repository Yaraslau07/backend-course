import { extname, join } from 'node:path';

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Piscina } from 'piscina';

import { ConfigService } from '@/core/config/config.service';

import type { TransformResult, TransformTask } from './worker/transform.worker';

/**
 * Converters run in a worker-thread pool (piscina), so a CPU-bound library never blocks the event
 * loop; the HTTP request still waits for its result (spec 2.0 §1.6). A conversion past its timeout
 * is aborted, and piscina terminates that thread: a stuck codec is stopped, not abandoned.
 * The timeout covers queueing too, so a saturated pool answers 504 instead of piling up.
 */
@Injectable()
export class TransformationPool implements OnModuleDestroy {
  private readonly logger = new Logger('Transformations');
  private readonly pool: Piscina;

  constructor(config: ConfigService) {
    // `.ts` under ts-jest and ts-node (tests), `.js` in the build (D67).
    const extension = extname(__filename);
    this.pool = new Piscina({
      filename: join(__dirname, 'worker', `transform.worker${extension}`),
      maxThreads: config.get('TRANSFORMATION_WORKER_THREADS'),
      minThreads: 0,
      idleTimeout: 30_000,
      maxQueue: 'auto',
      execArgv:
        extension === '.ts' ? ['-r', 'ts-node/register/transpile-only'] : [],
    });
  }

  async run(task: TransformTask, timeoutMs: number): Promise<TransformResult> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return (await this.pool.run(task, {
        signal: abort.signal,
      })) as TransformResult;
    } catch (error) {
      if (abort.signal.aborted) return { ok: false, code: 'timeout' };
      this.logger.warn(
        {
          event: 'transformation_pool',
          result: 'failure',
          category: error instanceof Error ? error.name : 'unknown',
        },
        'conversion worker failed',
      );
      return { ok: false, code: 'converter_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }
}
