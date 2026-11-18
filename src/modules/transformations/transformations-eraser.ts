import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type {
  EraseResult,
  UserDataEraser,
} from '@/modules/erasure/user-data-erasers';

/** Spec 2.0 §1.3.4, 1.6 §1.3.5: the user's transformation history (stored objects arrive in C19). */
@Injectable()
export class TransformationsEraser implements UserDataEraser {
  readonly owner = 'transformations';

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  eraseUserData(userId: string): Promise<EraseResult> {
    void [userId, this.db];
    throw new Error('not implemented');
  }
}
