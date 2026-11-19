import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@/core/config/config.service';
import {
  ObjectStorage,
  type StorageRead,
  type StorageListing,
  validStorageKey,
} from './object-storage';

/** Flat opaque keys, private regular files, and no filesystem storage in production. */
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
  async write(key: string, bytes: Buffer): Promise<'stored' | 'unavailable'> {
    const path = this.path(key);
    if (!path) return 'unavailable';
    try {
      await mkdir(resolve(this.config.get('STORAGE_LOCAL_ROOT')), {
        recursive: true,
      });
      try {
        await this.create(path, bytes);
        return 'stored';
      } catch (error) {
        if (!this.exists(error)) throw error;
        // The key is already there. Only an earlier attempt of this same write may stand in for it
        // (spec 2.4 §1.3.1): a regular file of the same size. Nothing is ever overwritten.
        const found = await lstat(path);
        return found.isFile() && found.size === bytes.length
          ? 'stored'
          : 'unavailable';
      }
    } catch {
      return 'unavailable';
    }
  }
  private async create(path: string, bytes: Buffer): Promise<void> {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
  }
  async list(cursor?: string): Promise<StorageListing> {
    if (this.config.get('NODE_ENV') === 'production')
      return { kind: 'unavailable' };
    try {
      const directory = resolve(this.config.get('STORAGE_LOCAL_ROOT'));
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter(
          (e) =>
            e.isFile() &&
            validStorageKey(e.name) &&
            (!cursor || e.name > cursor),
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const objects: { key: string; modifiedAt: Date }[] = [];
      for (const entry of entries.slice(0, 100)) {
        try {
          const stat = await lstat(resolve(directory, entry.name));
          if (stat.isFile())
            objects.push({ key: entry.name, modifiedAt: stat.mtime });
        } catch (error) {
          if (!this.missing(error)) throw error;
        }
      }
      return {
        kind: 'listed',
        objects,
        ...(entries.length > 100 ? { cursor: entries[99].name } : {}),
      };
    } catch (error) {
      return this.missing(error)
        ? { kind: 'listed', objects: [] }
        : { kind: 'unavailable' };
    }
  }
  private path(key: string): string | null {
    return this.config.get('NODE_ENV') === 'production' || !validStorageKey(key)
      ? null
      : resolve(this.config.get('STORAGE_LOCAL_ROOT'), key);
  }
  private exists(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    );
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
