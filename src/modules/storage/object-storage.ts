import type { Readable } from 'node:stream';

export type StorageRead =
  | { kind: 'found'; stream: Readable }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };
export type StorageListing =
  | {
      kind: 'listed';
      objects: { key: string; modifiedAt: Date }[];
      cursor?: string;
    }
  | { kind: 'unavailable' };

/** Opaque keys stay behind this port; errors never expose storage transport details. */
export abstract class ObjectStorage {
  abstract read(key: string): Promise<StorageRead>;
  abstract delete(
    key: string,
  ): Promise<'deleted' | 'not_found' | 'unavailable'>;
  /** Writing a key that already holds the same bytes is `stored` again (spec 2.4 §1.3.1). */
  abstract write(
    key: string,
    bytes: Buffer,
    contentType?: string,
  ): Promise<'stored' | 'unavailable'>;
  abstract list(cursor?: string): Promise<StorageListing>;
}
export function validStorageKey(key: string): boolean {
  const name = key.endsWith('.webp') ? key.slice(0, -5) : key;
  return name.length > 0 && name.length <= 128 && !/[^A-Za-z0-9_-]/.test(name);
}
/** Uploads take this shared transaction lock; reconciliation takes it exclusively. */
export const STORAGE_ADOPTION_LOCK = 1313101313;
