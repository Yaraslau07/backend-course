import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';

import { TransformationHistoryService } from './transformation-history.service';

const QUERY = [
  {
    name: 'cursor',
    required: false,
    description: 'nextCursor of the previous page',
  },
  { name: 'limit', required: false, description: '1–100, default 20' },
  { name: 'type', required: false, enum: ['file', 'image'] },
  { name: 'sourceFormat', required: false },
  { name: 'targetFormat', required: false },
  { name: 'status', required: false, enum: ['success', 'error'] },
  {
    name: 'createdAtFrom',
    required: false,
    description: 'Inclusive RFC 3339 date-time',
  },
  {
    name: 'createdAtTo',
    required: false,
    description: 'Exclusive RFC 3339 date-time',
  },
];
const PAGE = {
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['file', 'image'] },
            sourceFormat: { type: 'string' },
            targetFormat: { type: 'string' },
            status: { type: 'string', enum: ['success', 'error'] },
            inputSize: { type: 'number' },
            outputSize: { type: 'number', nullable: true },
            durationMs: { type: 'number' },
            errorCode: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            storageStatus: {
              type: 'string',
              enum: ['not_requested', 'pending', 'available', 'error'],
            },
            hasStoredFile: { type: 'boolean' },
            fileExpiresAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
          },
        },
      },
      nextCursor: { type: 'string', nullable: true },
    },
  },
};

function documented(): MethodDecorator & ClassDecorator {
  return (
    target: object,
    key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    for (const query of QUERY) ApiQuery(query)(target, key!, descriptor!);
  };
}

@ApiTags('transformations')
@ApiResponse({ status: 400, description: 'Invalid query, period or cursor' })
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({
  status: 429,
  description: '60 history reads per user per minute',
})
@ApiResponse({ status: 503, description: 'Database or RBAC unavailable' })
@Controller()
export class TransformationHistoryController {
  constructor(private readonly history: TransformationHistoryService) {}

  @Get('api/transformations/history')
  @RequirePermission('transformations', 'history')
  @RateLimit('history_user')
  @ApiOperation({ summary: 'Your transformation history, newest first' })
  @documented()
  @ApiOkResponse(PAGE)
  @ApiResponse({ status: 403, description: 'No transformations@history' })
  own(@CurrentUserId() actor: string, @Query() query: unknown) {
    return this.history.own(actor, query);
  }

  @Get('admin/users/:userId/transformations/history')
  @RequirePermission('transformations', 'history_any')
  @RateLimit('history_user')
  @ApiOperation({ summary: "A user's transformation history (admin)" })
  @ApiParam({ name: 'userId' })
  @documented()
  @ApiOkResponse(PAGE)
  @ApiResponse({ status: 403, description: 'No transformations@history_any' })
  @ApiResponse({
    status: 404,
    description: 'User not found after the permission check',
  })
  ofUser(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Query() query: unknown,
  ) {
    return this.history.ofUser(actor, target, query);
  }
}
