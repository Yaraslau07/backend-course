import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { ConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { ErrorsModule } from '@/core/errors/errors.module';
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
    ErrorsModule,
    DatabaseModule,
    HealthModule,
    AuthorizationModule,
    /**
     * Application modules
     */
    UsersModule,
  ],
})
export class AppModule {}
