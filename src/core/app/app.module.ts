import { Module } from '@nestjs/common';

import { ConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { LoggingModule } from '@/core/logging/logging.module';

/**
 * Application modules
 */
import { UsersModule } from '@/modules/users/users.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    HealthModule,
    /**
     * Application modules
     */
    UsersModule,
  ],
})
export class AppModule {}
