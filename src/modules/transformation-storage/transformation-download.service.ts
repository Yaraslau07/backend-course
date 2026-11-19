import { performance } from 'node:perf_hooks';
import { PassThrough, type Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { ObjectStorage } from '@/modules/storage/object-storage';
import type { TransformationStorageStatus } from '@/modules/transformations/transformation.types';
import { uuidOrNull } from '@/modules/users/user-ids';
import { validateUserId } from '@/modules/users/user-list-query';

import { contentTypeOf, fileNameOf } from './stored-result';

export interface StoredDownload {
  stream: Readable;
  contentType: string;
  fileName: string;
}

interface ItemRow {
  id: string;
  target_format: string;
  output_size: string | null;
  storage_status: TransformationStorageStatus;
  stored_file_key: string | null;
  live: boolean;
}

type Scope = 'self' | 'admin';

/**
 * Spec 2.4 §1.3.2–1.3.3. The guard has already required `download` (own) or `download_any` (admin),
 * so the lookup happens only after the permission. The own route looks the item up by id **and the
 * session's user**, so a foreign item is indistinguishable from a missing one (404).
 */
@Injectable()
export class TransformationDownloadService {
  private readonly logger = new Logger('TransformationStorage');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: ObjectStorage,
  ) {}

  own(actor: string, itemId: string): Promise<StoredDownload> {
    return this.open(actor, 'self', actor, itemId);
  }

  /** The path id follows D51: a valid non-UUID is an absent target, never a cast error. */
  async ofUser(
    actor: string,
    target: string,
    itemId: string,
  ): Promise<StoredDownload> {
    validateUserId(target);
    const [user] = await this.db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE id = $1`,
      [uuidOrNull(target)],
    );
    if (!user) throw new AppException('not_found');
    return this.open(actor, 'admin', user.id, itemId);
  }

  private async item(
    owner: string,
    itemId: string,
  ): Promise<ItemRow | undefined> {
    const [row] = await this.db.query<ItemRow[]>(
      `SELECT id, target_format, output_size, storage_status, stored_file_key,
              coalesce(stored_file_until > clock_timestamp(), false) AS live
         FROM transformations
        WHERE id = $1 AND user_id = $2`,
      [uuidOrNull(itemId), owner],
    );
    return row;
  }

  private async open(
    actor: string,
    scope: Scope,
    owner: string,
    itemId: string,
  ): Promise<StoredDownload> {
    const started = performance.now();
    const row = await this.item(owner, itemId);
    const log = (
      result: string,
      level: 'log' | 'error' = 'log',
      size: number | null = null,
    ) =>
      this.logger[level](
        {
          event: 'transformation_storage',
          action: 'download',
          scope,
          actorUserId: actor,
          ...(row ? { userId: owner, transformationId: row.id } : {}),
          size,
          result,
          durationMs: Math.round(performance.now() - started),
        },
        'transformation download',
      );

    // Unsaved, failed, expired or someone else's: all just "not available".
    if (
      !row ||
      row.storage_status === 'not_requested' ||
      row.storage_status === 'error' ||
      (row.storage_status === 'available' &&
        (!row.live || !row.stored_file_key))
    ) {
      log('not_found');
      throw new AppException('not_found');
    }
    if (row.storage_status === 'pending') {
      log('not_ready');
      throw new AppException('file_not_ready');
    }

    const object = await this.storage.read(row.stored_file_key as string);
    if (object.kind === 'not_found') {
      // Retention or the eraser may have deleted the object (and cleared the row) after we read
      // it. If the row no longer holds this key, that is just "gone" (404), not a mismatch (D81).
      const again = await this.item(owner, itemId);
      if (
        !again ||
        again.storage_status !== 'available' ||
        again.stored_file_key !== row.stored_file_key
      ) {
        log('not_found');
        throw new AppException('not_found');
      }
    }
    if (object.kind !== 'found') {
      // A key in history with no object (or storage down): never a 404 (spec 2.4 §1.3.2).
      log(
        object.kind === 'not_found'
          ? 'storage_mismatch'
          : 'storage_unavailable',
        'error',
      );
      throw new AppException('service_unavailable');
    }
    const size = row.output_size === null ? null : Number(row.output_size);
    log('success', 'log', size);

    // A late stream failure can't become a JSON response after bytes went out: log a safe category
    // and replace the transport error before Fastify's stream handler sees it (as the photo does).
    const output = new PassThrough();
    output.on('error', () => undefined);
    output.once('close', () => object.stream.destroy());
    object.stream.once('error', () => {
      this.logger.error(
        {
          event: 'transformation_storage',
          action: 'download',
          scope,
          actorUserId: actor,
          userId: owner,
          transformationId: row.id,
          size,
          result: 'stream_failed',
          durationMs: Math.round(performance.now() - started),
        },
        'transformation download stream failed',
      );
      output.destroy(new AppException('service_unavailable'));
    });
    object.stream.pipe(output);
    return {
      stream: output,
      contentType: contentTypeOf(row.target_format),
      fileName: fileNameOf(row.target_format),
    };
  }
}
