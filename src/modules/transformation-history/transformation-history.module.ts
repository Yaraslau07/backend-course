import { Module } from '@nestjs/common';

import { StorageModule } from '@/modules/storage/storage.module';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { TransformationHistoryController } from './transformation-history.controller';
import { TransformationHistoryService } from './transformation-history.service';
import { TransformationRetention } from './transformation-retention.service';

/** Spec 2.3: own and admin history pages, and history retention. */
@Module({
  imports: [TransformationsModule, StorageModule],
  controllers: [TransformationHistoryController],
  providers: [TransformationHistoryService, TransformationRetention],
})
export class TransformationHistoryModule {}
