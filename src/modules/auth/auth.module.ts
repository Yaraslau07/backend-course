import { Module } from '@nestjs/common';

import { ChallengesModule } from '@/modules/challenges/challenges.module';

import { PasswordHasher } from './password-hasher';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

@Module({
  imports: [ChallengesModule],
  controllers: [RegistrationController],
  providers: [PasswordHasher, RegistrationService],
  exports: [PasswordHasher],
})
export class AuthModule {}
