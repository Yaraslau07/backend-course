import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { ConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { ErrorsModule } from '@/core/errors/errors.module';
import { HealthModule } from '@/core/health/health.module';
import { MailModule } from '@/core/mail/mail.module';
import { RateLimitModule } from '@/core/rate-limit/rate-limit.module';
import { LoggingModule } from '@/core/logging/logging.module';

/**
 * Application modules
 */
import { ChallengesModule } from '@/modules/challenges/challenges.module';
import { UsersModule } from '@/modules/users/users.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ErrorsModule,
    DatabaseModule,
    HealthModule,
    RateLimitModule,
    MailModule,
    AuthorizationModule,
    /**
     * Application modules
     */
    ChallengesModule,
    UsersModule,
  ],
})
export class AppModule {}
