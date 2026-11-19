import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  constants,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ReadinessRegistry } from '@/core/health/readiness.registry';

/** A file older than this at startup was left by a crashed process. */
const STALE_MS = 3600 * 1000;
/** A saved result's copy waits at most this long for the background write (spec 2.4 §1.3.1). */
const PENDING_STALE_MS = 24 * 3600 * 1000;
const NAME = /^[0-9a-f]{32}$/;

/**
 * The private temporary area for inputs and results (spec 2.0 §1.3.4): one directory, mode 0700,
 * outside anything served. Names are 128 random bits, never the upload's name. Files are removed
 * on every outcome; leftovers from a crash are swept at the next start.
 */
@Injectable()
export class TempArea implements OnModuleInit {
  private readonly logger = new Logger('Transformations');
  readonly root: string;
  /** Copies of results waiting for object storage, named by their storage key (spec 2.4). */
  readonly pending: string;

  constructor(
    config: ConfigService,
    private readonly readiness: ReadinessRegistry,
  ) {
    this.root = resolve(
      config.get('TRANSFORMATION_TEMP_DIR') ||
        join(tmpdir(), 'backend-course-transformations'),
    );
    this.pending = join(this.root, 'pending');
  }

  async onModuleInit(): Promise<void> {
    this.readiness.register('transformation_temp', async () => {
      try {
        await access(this.root, constants.W_OK);
        return (await stat(this.root)).isDirectory()
          ? 'up'
          : { down: 'unavailable' };
      } catch {
        return { down: 'unavailable' };
      }
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await this.sweep(this.root, STALE_MS);
    await this.sweepPending();
  }

  /** A new path with a server-generated random name; never derived from the upload's name. */
  path(): string {
    return join(this.root, randomBytes(16).toString('hex'));
  }

  /** Idempotent. Refuses anything that isn't one of this area's own names. */
  async remove(path: string): Promise<void> {
    const name = path.slice(this.root.length + 1);
    if (dirname(path) !== this.root || !NAME.test(name))
      throw new Error('not a temporary file of this area');
    await rm(path, { force: true });
  }

  /**
   * Spec 2.4 §1.3.1 step 2: a private copy of the result under a new random storage key (128 bits,
   * D55), which the background write reads. `null` means no copy could be made.
   */
  async keep(source: string): Promise<string | null> {
    const key = randomBytes(16).toString('hex');
    try {
      await mkdir(this.pending, { recursive: true, mode: 0o700 });
      await copyFile(source, join(this.pending, key), constants.COPYFILE_EXCL);
      return key;
    } catch {
      await rm(join(this.pending, key), { force: true }).catch(() => undefined);
      return null;
    }
  }

  /** The whole copy, or `null` when it is gone (the save then becomes an error). */
  async readPending(key: string): Promise<Buffer | null> {
    if (!NAME.test(key)) return null;
    try {
      return await readFile(join(this.pending, key));
    } catch {
      return null;
    }
  }

  /** Idempotent; a key that isn't one of ours is ignored. */
  async removePending(key: string): Promise<void> {
    if (NAME.test(key)) await rm(join(this.pending, key), { force: true });
  }

  private async sweepPending(): Promise<void> {
    try {
      await this.sweep(this.pending, PENDING_STALE_MS);
    } catch {
      // No pending directory yet: nothing was ever kept.
    }
  }

  private async sweep(directory: string, staleMs: number): Promise<void> {
    let removed = 0;
    for (const name of await readdir(directory)) {
      if (!NAME.test(name)) continue;
      const path = join(directory, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > staleMs) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        // Removed concurrently: nothing to do.
      }
    }
    if (removed > 0)
      this.logger.log(
        { event: 'transformation_temp_sweep', count: removed },
        'stale temporary files removed',
      );
  }
}
