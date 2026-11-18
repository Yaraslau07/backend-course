import { Injectable } from '@nestjs/common';

import type {
  EraseResult,
  UserDataEraser,
} from '@/modules/erasure/user-data-erasers';

/** The users module's own data: the profile photo object (the row itself is anonymized last). */
@Injectable()
export class ProfileEraser implements UserDataEraser {
  readonly owner = 'profile';

  eraseUserData(userId: string, deletionJobId: string): Promise<EraseResult> {
    void [userId, deletionJobId];
    throw new Error('not implemented');
  }
}
