import { Module } from '@nestjs/common';
import { ConfigService } from '@/core/config/config.service';
import { LocalObjectStorage } from './local-object-storage';
import { S3ObjectStorage } from './s3-object-storage';
import { ObjectStorage } from './object-storage';
import { StorageCleanup } from './storage-cleanup.service';

@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('STORAGE_DRIVER') === 's3'
          ? new S3ObjectStorage(config)
          : new LocalObjectStorage(config),
    },
    StorageCleanup,
  ],
  exports: [ObjectStorage, StorageCleanup],
})
export class StorageModule {}
