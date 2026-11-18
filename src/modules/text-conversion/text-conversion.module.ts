import { extname, join } from 'node:path';

import { Module, type OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { TextConversionController } from './text-conversion.controller';
import { TEXT_FORMATS } from './text-formats';
import { TEXT_OUTPUT_BYTES, textLimits } from './text-operation';

/** Spec 2.1: CSV, JSON, XML and YAML in all twelve directions, through the framework (2.0). */
@Module({
  imports: [TransformationsModule],
  controllers: [TextConversionController],
})
export class TextConversionModule implements OnModuleInit {
  constructor(
    private readonly registry: ConverterRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const limits = textLimits((key) => this.config.get(key));
    // `.ts` under tests, `.js` in the build (D67).
    const module = join(__dirname, `text.converter${extname(__filename)}`);
    for (const source of TEXT_FORMATS)
      for (const target of TEXT_FORMATS)
        if (source !== target)
          this.registry.register({
            type: 'file',
            source,
            target,
            module,
            limits: {
              inputBytes: limits[source],
              outputBytes: TEXT_OUTPUT_BYTES,
              timeoutMs: this.config.get('TEXT_CONVERSION_TIMEOUT_MS'),
            },
          });
  }
}
