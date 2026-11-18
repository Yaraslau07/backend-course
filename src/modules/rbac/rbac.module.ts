import { Module } from '@nestjs/common';

import { RbacAdminController } from './rbac-admin.controller';
import { RbacAdminService } from './rbac-admin.service';
import { RbacAuthorizer } from './rbac-authorizer';
import { RbacBootstrap } from './rbac-bootstrap';
import { RbacPolicyStore } from './rbac-policy.store';
import { RbacPermissionSeeds } from './permission-seeds';

@Module({
  controllers: [RbacAdminController],
  providers: [
    RbacPolicyStore,
    RbacAuthorizer,
    RbacBootstrap,
    RbacAdminService,
    RbacPermissionSeeds,
  ],
  // The route guard authorizes every protected route; registration assigns the default role.
  exports: [RbacAuthorizer, RbacPermissionSeeds],
})
export class RbacModule {}
