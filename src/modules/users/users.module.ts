import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { StorageModule } from '@/modules/storage/storage.module';
import { ChallengesModule } from '@/modules/challenges/challenges.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { UsersUpdateService } from './users-update.service';
import { UsersUpdateController } from './users-update.controller';
import { PhotoNormalizer } from './photo-normalizer';
import { UsersUpdateAuditInterceptor } from './users-update-audit.interceptor';

import { UserListCursor } from './user-list-cursor.service';
import { UsersReadController } from './users-read.controller';
import { UsersReadService } from './users-read.service';

@Module({
  imports: [AuthorizationModule, StorageModule, ChallengesModule, RbacModule],
  providers: [
    UserListCursor,
    UsersReadService,
    UsersUpdateService,
    PhotoNormalizer,
    UsersUpdateAuditInterceptor,
  ],
  controllers: [UsersReadController, UsersUpdateController],
})
export class UsersModule {}
