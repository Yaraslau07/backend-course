import type { Readable } from 'node:stream';

export type StorageRead =
  | { kind: 'found'; stream: Readable }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** Opaque keys stay behind this port; readers never receive paths, buckets or transport errors. */
export abstract class ObjectStorage {
  abstract read(key: string): Promise<StorageRead>;
  abstract delete(
    key: string,
  ): Promise<'deleted' | 'not_found' | 'unavailable'>;
}
