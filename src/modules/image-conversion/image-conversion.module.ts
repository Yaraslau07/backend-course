import { extname, join } from 'node:path';

import { Module, type OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { ImageConversionController } from './image-conversion.controller';
import { IMAGE_OUTPUT_BYTES, imageLimits } from './image-operation';

/** Spec 2.2 §1.3.1: exactly these four directions, in the order of the formats list. */
const DIRECTIONS = [
  ['png', 'jpeg'],
  ['jpeg', 'png'],
  ['svg', 'png'],
  ['svg', 'jpeg'],
] as const;

/** Spec 2.2: PNG ↔ JPEG with sharp, SVG → PNG/JPEG with resvg, through the framework (2.0). */
@Module({
  imports: [TransformationsModule],
  controllers: [ImageConversionController],
})
export class ImageConversionModule implements OnModuleInit {
  constructor(
    private readonly registry: ConverterRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const limits = imageLimits((key) => this.config.get(key));
    const module = join(__dirname, `image.converter${extname(__filename)}`);
    for (const [source, target] of DIRECTIONS)
      this.registry.register({
        type: 'image',
        source,
        target,
        module,
        limits: {
          inputBytes: limits[source],
          outputBytes: IMAGE_OUTPUT_BYTES,
          timeoutMs: this.config.get('IMAGE_CONVERSION_TIMEOUT_MS'),
        },
      });
  }
}
