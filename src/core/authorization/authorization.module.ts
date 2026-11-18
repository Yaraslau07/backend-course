import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { CsrfPolicy } from './csrf';
import { IdempotentReplays } from './idempotent-replay';
import { Ownership } from './ownership';
import { RouteAccessGuard } from './route-access.guard';
import { RouteDeclarationScanner } from './route-scan';

@Module({
  imports: [DiscoveryModule, AuthModule, RbacModule],
  providers: [
    CsrfPolicy,
    Ownership,
    IdempotentReplays,
    RouteDeclarationScanner,
    { provide: APP_GUARD, useClass: RouteAccessGuard },
  ],
  // Feature modules import this module for the ownership step in their handlers.
  exports: [Ownership, IdempotentReplays],
})
export class AuthorizationModule {}
