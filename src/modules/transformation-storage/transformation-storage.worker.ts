import { Injectable } from '@nestjs/common';

/** Spec 2.4 §1.3.1 step 5: writes `pending` results to object storage. Implemented in C19. */
@Injectable()
export class TransformationStorageWorker {
  /** One pass over due `pending` rows; returns how many it settled. */
  run(): Promise<number> {
    throw new Error('not implemented');
  }
}
