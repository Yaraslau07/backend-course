import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { StorageModule } from '@/modules/storage/storage.module';

import { UserListCursor } from './user-list-cursor.service';
import { UsersReadController } from './users-read.controller';
import { UsersReadService } from './users-read.service';

@Module({
  imports: [AuthorizationModule, StorageModule],
  providers: [UserListCursor, UsersReadService],
  controllers: [UsersReadController],
})
export class UsersModule {}
