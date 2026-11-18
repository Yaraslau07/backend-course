import { join } from 'node:path';

import {
  Controller,
  Injectable,
  Module,
  type OnModuleInit,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';
import { AppException } from '@/core/errors/app.exception';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';
import {
  type ConversionOperation,
  TransformationService,
} from '@/modules/transformations/transformation.service';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

export const PROBE_LIMITS = {
  inputBytes: 1024,
  outputBytes: 2048,
  timeoutMs: 1500,
};

/** A test-only direction `probe → upper`, and a second one (`probe → lower`) for registry checks. */
@Injectable()
export class ProbeDirections implements OnModuleInit {
  constructor(private readonly registry: ConverterRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'file',
      source: 'probe',
      target: 'upper',
      module: join(__dirname, 'probe-converter.ts'),
      limits: PROBE_LIMITS,
    });
  }
}

const OPERATION: ConversionOperation = {
  type: 'file',
  fields: ['targetFormat', 'mode', 'size'],
  maxFileBytes: 4096,
  limitFor: (extension) =>
    extension === 'probe' ? PROBE_LIMITS.inputBytes : null,
  resolve: (upload) => {
    if (upload.fields.targetFormat === undefined)
      throw new AppException('bad_request');
    return {
      source: upload.file.extension,
      target: upload.fields.targetFormat,
      params: { mode: upload.fields.mode, size: upload.fields.size },
    };
  },
};

@Controller('test/transform')
class TransformProbeController {
  constructor(private readonly transformations: TransformationService) {}

  @Post()
  @RequirePermission('transformations', 'convert')
  convert(
    @CurrentUserId() userId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.transformations.handle(userId, request, reply, OPERATION);
  }
}

@Module({
  imports: [TransformationsModule],
  providers: [ProbeDirections],
  controllers: [TransformProbeController],
})
export class TransformProbeModule {}
