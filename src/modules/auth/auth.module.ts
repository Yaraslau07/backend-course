import { Module } from '@nestjs/common';

import { ChallengesModule } from '@/modules/challenges/challenges.module';

import { AccessAuthenticator } from './access-authenticator';
import { AuthCookies } from './auth-cookies';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';
import { PasswordHasher } from './password-hasher';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { SessionService } from './session.service';
import { TokenService } from './tokens/token.service';

@Module({
  imports: [ChallengesModule],
  controllers: [RegistrationController, LoginController],
  providers: [
    PasswordHasher,
    RegistrationService,
    TokenService,
    AuthCookies,
    AccessAuthenticator,
    LoginService,
    SessionService,
  ],
  // The route guard (core/authorization) runs the access check on every protected route.
  exports: [PasswordHasher, AccessAuthenticator],
})
export class AuthModule {}
