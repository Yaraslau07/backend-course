import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@/core/config/config.service';
import {
  ObjectStorage,
  type StorageRead,
  type StorageListing,
  validStorageKey,
} from './object-storage';

@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  constructor(private readonly config: ConfigService) {
    super();
    this.client = new S3Client({
      region: config.get('S3_REGION'),
      endpoint: config.get('S3_ENDPOINT'),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID')!,
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY')!,
      },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    });
  }
  onModuleDestroy(): void {
    this.client.destroy();
  }
  async read(key: string): Promise<StorageRead> {
    if (!validStorageKey(key)) return { kind: 'unavailable' };
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.get('S3_BUCKET'),
          Key: this.key(key),
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return result.Body instanceof Readable
        ? { kind: 'found', stream: result.Body }
        : { kind: 'unavailable' };
    } catch (error: unknown) {
      return {
        kind:
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error.name === 'NoSuchKey' || error.name === 'NotFound')
            ? 'not_found'
            : 'unavailable',
      };
    }
  }
  async write(
    key: string,
    bytes: Buffer,
    contentType = 'image/webp',
  ): Promise<'stored' | 'unavailable'> {
    if (!validStorageKey(key)) return 'unavailable';
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.get('S3_BUCKET'),
          Key: this.key(key),
          Body: bytes,
          ContentType: contentType,
          IfNoneMatch: '*',
        }),
        {
          abortSignal: AbortSignal.timeout(this.uploadTimeoutMs(bytes.length)),
        },
      );
      return 'stored';
    } catch (error) {
      // The key is random (D55), so a failed precondition is an earlier attempt of this same write.
      return this.conflict(error) ? 'stored' : 'unavailable';
    }
  }
  /** 5 s plus 1 s per MiB, at most 5 minutes: a large result can't finish inside a flat 5 s. */
  private uploadTimeoutMs(size: number): number {
    return Math.min(5000 + Math.ceil(size / (1024 * 1024)) * 1000, 300_000);
  }
  private conflict(error: unknown): boolean {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
      ?.$metadata?.httpStatusCode;
    return status === 412;
  }
  async delete(key: string): Promise<'deleted' | 'not_found' | 'unavailable'> {
    if (!validStorageKey(key)) return 'unavailable';
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.get('S3_BUCKET'),
          Key: this.key(key),
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return 'deleted';
    } catch {
      return 'unavailable';
    }
  }
  async list(cursor?: string): Promise<StorageListing> {
    try {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.get('S3_BUCKET'),
          Prefix: this.config.get('S3_PREFIX'),
          MaxKeys: 100,
          ContinuationToken: cursor,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      const objects = (result.Contents ?? []).flatMap((item) => {
        const key = item.Key?.slice(this.config.get('S3_PREFIX').length);
        return item.Key?.startsWith(this.config.get('S3_PREFIX')) &&
          key &&
          validStorageKey(key) &&
          item.LastModified
          ? [{ key, modifiedAt: item.LastModified }]
          : [];
      });
      return {
        kind: 'listed',
        objects,
        ...(result.NextContinuationToken
          ? { cursor: result.NextContinuationToken }
          : {}),
      };
    } catch {
      return { kind: 'unavailable' };
    }
  }
  private key(key: string): string {
    return `${this.config.get('S3_PREFIX')}${key}`;
  }
}
