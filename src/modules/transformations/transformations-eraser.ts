import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type {
  EraseResult,
  UserDataEraser,
} from '@/modules/erasure/user-data-erasers';

const BATCH = 1000;

/**
 * Spec 2.0 §1.3.4 and 1.6 §1.3.5: the user's history rows, in small batches. Stored objects come
 * with spec 2.4 (C19) and will be deleted before their rows. Missing rows are already deleted.
 */
@Injectable()
export class TransformationsEraser implements UserDataEraser {
  readonly owner = 'transformations';

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async eraseUserData(userId: string): Promise<EraseResult> {
    try {
      for (;;) {
        const [, deleted] = await this.db.query<[unknown[], number]>(
          `DELETE FROM transformations
            WHERE id IN (SELECT id FROM transformations WHERE user_id = $1 LIMIT $2)`,
          [userId, BATCH],
        );
        if (deleted < BATCH) return { result: 'succeeded' };
      }
    } catch {
      return { result: 'retryable_failure', code: 'history_unavailable' };
    }
  }
}
