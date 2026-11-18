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

import { imageLimits, imageOperation } from './image-operation';

@ApiTags('transformations')
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({
  status: 403,
  description: 'No transformations@convert, or CSRF refused',
})
@Controller('api/images/convert')
export class ImageConversionController {
  private readonly operation: ConversionOperation;

  constructor(
    private readonly transformations: TransformationService,
    private readonly registry: ConverterRegistry,
    config: ConfigService,
  ) {
    this.operation = imageOperation(
      imageLimits((key) => config.get(key)),
      config.get('IMAGE_CONVERSION_TIMEOUT_MS'),
    );
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('transformations', 'convert')
  @ApiOperation({
    summary: 'Convert PNG → JPEG, JPEG → PNG, or SVG → PNG/JPEG',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      additionalProperties: false,
      properties: {
        file: { type: 'string', format: 'binary' },
        targetFormat: { type: 'string', enum: ['png', 'jpeg'] },
        options: {
          type: 'string',
          description:
            'JSON: {"quality":1–100 (JPEG), "background":"#RRGGBB" (JPEG), "width"/"height":1–4096 (SVG)}',
        },
        save: { type: 'string', enum: ['true', 'false'] },
      },
    },
  })
  @ApiProduces('image/png', 'image/jpeg')
  @ApiOkResponse({
    description:
      'The converted image, attachment `converted.<ext>`, with `X-Transformation-Id`',
  })
  @ApiResponse({
    status: 400,
    description: 'Damaged file, invalid options, unsafe SVG or animated PNG',
  })
  @ApiResponse({
    status: 413,
    description:
      'Input over its limit, or a result over 4096 px / 16,777,216 px',
  })
  @ApiResponse({ status: 415, description: 'Unsupported format or direction' })
  @ApiResponse({
    status: 503,
    description: 'History, temporary area or library unavailable',
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
  @ApiOperation({ summary: 'The supported image directions' })
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
    return this.registry.directions('image');
  }
}
