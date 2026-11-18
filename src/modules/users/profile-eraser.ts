import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  type EraseResult,
  type UserDataEraser,
  UserDataErasers,
} from '@/modules/erasure/user-data-erasers';
import { ObjectStorage } from '@/modules/storage/object-storage';

import type { UserStatus } from './users.types';

/**
 * The users module's own data apart from the row: the profile photo object (spec 1.6 §1.3.5).
 * The row's PII is anonymized by the worker's final transaction, which re-checks `photo_key`.
 * Idempotent: no photo, an already deleted object, or a second call all succeed.
 */
@Injectable()
export class ProfileEraser implements UserDataEraser, OnModuleInit {
  readonly owner = 'profile';
  private readonly logger = new Logger('ProfileEraser');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly storage: ObjectStorage,
    private readonly erasers: UserDataErasers,
  ) {}

  onModuleInit(): void {
    this.erasers.register(this);
  }

  async eraseUserData(userId: string): Promise<EraseResult> {
    const [row] = await this.db.query<
      { status: UserStatus; photo_key: string | null }[]
    >(`SELECT status, photo_key FROM users WHERE id = $1`, [userId]);
    if (!row?.photo_key) return { result: 'succeeded' };
    // Never erase for an account that isn't being deleted (a job/user mismatch is a bug, not a retry).
    if (row.status !== 'deleting')
      return { result: 'permanent_failure', code: 'user_not_deleting' };
    const deleted = await this.storage.delete(row.photo_key);
    if (deleted === 'unavailable') {
      this.logger.warn(
        { event: 'eraser', owner: this.owner, result: 'storage_unavailable' },
        'profile photo erase deferred',
      );
      return { result: 'retryable_failure', code: 'storage_unavailable' };
    }
    // `deleting` blocks every photo write, so the reference can only be the one just removed.
    await this.db.query(
      `UPDATE users SET photo_key = NULL WHERE id = $1 AND photo_key = $2 AND status = 'deleting'`,
      [userId, row.photo_key],
    );
    return { result: 'succeeded' };
  }
}
