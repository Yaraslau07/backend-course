import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { RouteAccessGuard } from './route-access.guard';
import { RouteDeclarationScanner } from './route-scan';

@Module({
  imports: [DiscoveryModule],
  providers: [
    RouteDeclarationScanner,
    { provide: APP_GUARD, useClass: RouteAccessGuard },
  ],
})
export class AuthorizationModule {}
