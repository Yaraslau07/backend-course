import { Module } from '@nestjs/common';

import { UserDataErasers, USER_DATA_OWNERS } from './user-data-erasers';
import { ReadinessRegistry } from '@/core/health/readiness.registry';

/** The eraser registry the deletion worker runs (spec 1.6 §1.3.5). Modules with user data import it. */
@Module({
  providers: [
    {
      provide: UserDataErasers,
      inject: [ReadinessRegistry],
      useFactory: (readiness: ReadinessRegistry) =>
        new UserDataErasers(readiness, USER_DATA_OWNERS),
    },
  ],
  exports: [UserDataErasers],
})
export class ErasureModule {}
