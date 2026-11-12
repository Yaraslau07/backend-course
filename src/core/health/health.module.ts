import { Global, Module } from '@nestjs/common';

import { BuiltinReadinessChecks } from './builtin-checks';
import { HealthController } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';

/** Global so any feature module can inject `ReadinessRegistry` and register its own checks. */
@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessRegistry, BuiltinReadinessChecks],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
