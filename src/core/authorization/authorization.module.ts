import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { AuthModule } from '@/modules/auth/auth.module';

import { CsrfPolicy } from './csrf';
import { RouteAccessGuard } from './route-access.guard';
import { RouteDeclarationScanner } from './route-scan';

@Module({
  imports: [DiscoveryModule, AuthModule],
  providers: [
    CsrfPolicy,
    RouteDeclarationScanner,
    { provide: APP_GUARD, useClass: RouteAccessGuard },
  ],
})
export class AuthorizationModule {}
