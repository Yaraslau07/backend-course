import { Injectable } from '@nestjs/common';

import type { TransformResult, TransformTask } from './worker/transform.worker';

/** Runs converters in a worker-thread pool so a busy library never blocks the event loop (spec 2.0 §1.6). */
@Injectable()
export class TransformationPool {
  run(task: TransformTask, timeoutMs: number): Promise<TransformResult> {
    void [task, timeoutMs];
    throw new Error('not implemented');
  }
}
