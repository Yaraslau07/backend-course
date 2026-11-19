import { Module } from '@nestjs/common';

import { StorageModule } from '@/modules/storage/storage.module';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { TransformationDownloadController } from './transformation-download.controller';
import { TransformationDownloadService } from './transformation-download.service';
import { TransformationStorageWorker } from './transformation-storage.worker';

/** Spec 2.4: the background write of saved results, and the own and admin downloads. */
@Module({
  imports: [TransformationsModule, StorageModule],
  controllers: [TransformationDownloadController],
  providers: [TransformationDownloadService, TransformationStorageWorker],
})
export class TransformationStorageModule {}
