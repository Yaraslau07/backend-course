import { Injectable } from '@nestjs/common';

import type { EraseResult } from '@/modules/erasure/user-data-erasers';
import type { DeletionJobStatus } from './users.types';

/** At most 5 automatic starts, 1 minute apart (spec 1.6 §1.3.5). */
export const DELETION_MAX_ATTEMPTS = 5;
export const DELETION_RETRY_SECONDS = 60;

/** Where a job goes after an unsuccessful start. */
export function afterFailure(
  result: Exclude<EraseResult, { result: 'succeeded' }>,
  attempts: number,
): Extract<DeletionJobStatus, 'queued' | 'failed'> {
  void [result, attempts];
  throw new Error('not implemented');
}

@Injectable()
export class DeletionWorker {
  /** Claims and processes due jobs; returns how many were processed. */
  run(limit = 10): Promise<number> {
    void limit;
    throw new Error('not implemented');
  }
}
