import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';
import { ConfigService } from '@/core/config/config.service';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';
import {
  type ConversionOperation,
  TransformationService,
} from '@/modules/transformations/transformation.service';

import { textLimits, textOperation } from './text-operation';

@ApiTags('transformations')
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({
  status: 403,
  description: 'No transformations@convert, or CSRF refused',
})
@Controller('api/convert')
export class TextConversionController {
  private readonly operation: ConversionOperation;

  constructor(
    private readonly transformations: TransformationService,
    private readonly registry: ConverterRegistry,
    config: ConfigService,
  ) {
    this.operation = textOperation(textLimits((key) => config.get(key)));
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('transformations', 'convert')
  @ApiOperation({
    summary: 'Convert CSV, JSON, XML or YAML to another of them',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      additionalProperties: false,
      properties: {
        file: { type: 'string', format: 'binary' },
        targetFormat: { type: 'string', enum: ['csv', 'json', 'xml', 'yaml'] },
        save: { type: 'string', enum: ['true', 'false'] },
      },
    },
  })
  @ApiProduces(
    'text/csv',
    'application/json',
    'application/xml',
    'application/yaml',
  )
  @ApiOkResponse({
    description:
      'The converted file, attachment `converted.<ext>`, with `X-Transformation-Id`',
  })
  @ApiResponse({
    status: 400,
    description:
      'Empty file, bad syntax or encoding, invalid fields, or a structure the target cannot hold',
  })
  @ApiResponse({ status: 413, description: 'Input or result over its limit' })
  @ApiResponse({
    status: 415,
    description: 'Unsupported format, or MIME type contradicting the extension',
  })
  @ApiResponse({
    status: 503,
    description: 'History or temporary storage unavailable',
  })
  @ApiResponse({ status: 504, description: 'Not finished within 30 seconds' })
  convert(
    @CurrentUserId() userId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.transformations.handle(userId, request, reply, this.operation);
  }

  @Get('formats')
  @RequirePermission('transformations', 'convert')
  @ApiOperation({ summary: 'The supported text directions' })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  })
  formats() {
    return this.registry.directions('file');
  }
}
