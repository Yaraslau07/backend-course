import { Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { ErasureModule } from '@/modules/erasure/erasure.module';
import {
  type EraseResult,
  UserDataErasers,
} from '@/modules/erasure/user-data-erasers';

/**
 * A test-only eraser whose answer a test sets (spec 1.6: retry, permanent failure, repeat).
 * It succeeds by default, so other jobs in the suite are unaffected.
 */
@Injectable()
export class ProbeEraser implements OnModuleInit {
  readonly owner = 'probe';
  next: EraseResult | 'throw' = { result: 'succeeded' };
  readonly calls: { userId: string; jobId: string }[] = [];
  /** Runs before answering, while the job is still claimed (to observe its lease). */
  before?: (jobId: string) => Promise<void>;

  constructor(private readonly erasers: UserDataErasers) {}

  onModuleInit(): void {
    this.erasers.register(this);
  }

  async eraseUserData(userId: string, jobId: string): Promise<EraseResult> {
    this.calls.push({ userId, jobId });
    await this.before?.(jobId);
    if (this.next === 'throw') throw new Error('probe');
    return this.next;
  }
}

@Module({ imports: [ErasureModule], providers: [ProbeEraser] })
export class EraserProbeModule {}
