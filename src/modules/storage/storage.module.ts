import { Module } from '@nestjs/common';

import { LocalObjectStorage } from './local-object-storage';
import { ObjectStorage } from './object-storage';

@Module({
  providers: [{ provide: ObjectStorage, useClass: LocalObjectStorage }],
  exports: [ObjectStorage],
})
export class StorageModule {}
