import { Module } from '@nestjs/common';

import { ErasureModule } from '@/modules/erasure/erasure.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { StorageModule } from '@/modules/storage/storage.module';

import { ConverterRegistry } from './converter-registry';
import { TempArea } from './temp-area';
import { TransformationPool } from './transformation-pool';
import { TransformationService } from './transformation.service';
import { TransformationsEraser } from './transformations-eraser';
import { TransformationsSetup } from './transformations.setup';

/**
 * The transformation framework (spec 2.0): registry, worker pool, temporary area, history writes,
 * permission seed and eraser. The text (2.1) and image (2.2) modules import it, register their
 * directions and call `TransformationService.handle()` from their endpoints.
 */
@Module({
  imports: [RbacModule, ErasureModule, StorageModule],
  providers: [
    ConverterRegistry,
    TempArea,
    TransformationPool,
    TransformationService,
    TransformationsEraser,
    TransformationsSetup,
  ],
  exports: [ConverterRegistry, TempArea, TransformationService],
})
export class TransformationsModule {}
