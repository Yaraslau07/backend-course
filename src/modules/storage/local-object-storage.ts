import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { ObjectStorage, type StorageRead } from './object-storage';

/** Flat opaque keys, no public directory. Local storage is deliberately disabled in production. */
@Injectable()
export class LocalObjectStorage extends ObjectStorage {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async read(key: string): Promise<StorageRead> {
    const path = this.path(key);
    if (!path) return { kind: 'unavailable' };
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) {
          await file.close();
          return { kind: 'unavailable' };
        }
        return {
          kind: 'found',
          stream: file.createReadStream({ autoClose: true }),
        };
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (error) {
      return { kind: this.missing(error) ? 'not_found' : 'unavailable' };
    }
  }

  async delete(key: string): Promise<'deleted' | 'not_found' | 'unavailable'> {
    const path = this.path(key);
    if (!path) return 'unavailable';
    try {
      if (!(await lstat(path)).isFile()) return 'unavailable';
      await unlink(path);
      return 'deleted';
    } catch (error) {
      return this.missing(error) ? 'not_found' : 'unavailable';
    }
  }

  private path(key: string): string | null {
    const name = key.endsWith('.webp') ? key.slice(0, -5) : key;
    if (
      this.config.get('NODE_ENV') === 'production' ||
      name.length < 1 ||
      name.length > 128 ||
      /[^A-Za-z0-9_-]/.test(name)
    )
      return null;
    return resolve(this.config.get('STORAGE_LOCAL_ROOT'), key);
  }

  private missing(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }
}
