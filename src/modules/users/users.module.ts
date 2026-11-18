import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { StorageModule } from '@/modules/storage/storage.module';
import { ChallengesModule } from '@/modules/challenges/challenges.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ErasureModule } from '@/modules/erasure/erasure.module';
import { UsersUpdateService } from './users-update.service';
import { UsersUpdateController } from './users-update.controller';
import { PhotoNormalizer } from './photo-normalizer';
import { UsersUpdateAuditInterceptor } from './users-update-audit.interceptor';
import { UsersDeletionController } from './users-deletion.controller';
import { UsersDeletionService } from './users-deletion.service';
import { DeletionWorker } from './deletion-worker.service';
import { ProfileEraser } from './profile-eraser';

import { UserListCursor } from './user-list-cursor.service';
import { UsersReadController } from './users-read.controller';
import { UsersReadService } from './users-read.service';

@Module({
  imports: [
    AuthorizationModule,
    AuthModule,
    StorageModule,
    ChallengesModule,
    RbacModule,
    ErasureModule,
  ],
  providers: [
    UserListCursor,
    UsersReadService,
    UsersUpdateService,
    PhotoNormalizer,
    UsersUpdateAuditInterceptor,
    UsersDeletionService,
    DeletionWorker,
    ProfileEraser,
  ],
  controllers: [
    UsersReadController,
    UsersUpdateController,
    UsersDeletionController,
  ],
})
export class UsersModule {}
