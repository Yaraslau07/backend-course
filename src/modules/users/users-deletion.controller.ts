import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUserId } from '@/core/authorization/current-user';
import {
  Receipt,
  Replay,
  RequirePermission,
} from '@/core/authorization/route-access';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';
import { AuthCookies } from '@/modules/auth/auth-cookies';

import { assertNoBody } from './deletion-input';
import { UsersDeletionService } from './users-deletion.service';

const KEY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description:
    '32 lowercase hex characters from 16 random bytes, chosen by the client; it becomes the jobId.',
};
const RECEIPT = {
  type: 'object',
  properties: {
    jobId: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'succeeded', 'failed'],
    },
    statusUrl: { type: 'string', example: '/users/{userId}/deletion-status' },
  },
};
const CHALLENGE = {
  type: 'object',
  properties: {
    confirmationRequired: { type: 'boolean', enum: [true] },
    method: { type: 'string', enum: ['otp', 'magic_link'] },
    challengeId: { type: 'string', format: 'uuid' },
    expiresInSeconds: { type: 'number', example: 600 },
    resendAfterSeconds: { type: 'number', example: 60 },
  },
};

/**
 * Spec 1.6: self deletion through an email challenge, admin deletion, and the status endpoint.
 * The accepting transaction makes the account `deleting`; `DeletionWorker` does the rest.
 */
@ApiTags('users')
@ApiResponse({
  status: 400,
  description: 'Invalid path, header, body or challenge',
})
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({
  status: 403,
  description: 'Permission, ownership or CSRF denied',
})
@ApiResponse({ status: 503, description: 'Dependency unavailable' })
@Controller('users/:userId')
export class UsersDeletionController {
  constructor(
    private readonly deletion: UsersDeletionService,
    private readonly cookies: AuthCookies,
  ) {}

  @Post('deletion-challenge')
  @HttpCode(202)
  @RequirePermission('users', 'delete')
  @ApiOperation({ summary: 'Email a deletion confirmation to yourself' })
  @ApiAcceptedResponse({ schema: CHALLENGE })
  @ApiResponse({ status: 409, description: 'A deletion job already exists' })
  @ApiResponse({ status: 429, description: 'Cooldown or hourly email limit' })
  start(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    assertNoBody(body, request.headers);
    return this.deletion.startChallenge(actor, target);
  }

  @Post('deletion-challenge/resend')
  @HttpCode(202)
  @RequirePermission('users', 'delete')
  @ApiOperation({ summary: 'Resend your deletion confirmation' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['challengeId'],
      additionalProperties: false,
      properties: { challengeId: { type: 'string', format: 'uuid' } },
    },
  })
  @ApiAcceptedResponse({ schema: CHALLENGE })
  @ApiResponse({ status: 409, description: 'A deletion job already exists' })
  @ApiResponse({
    status: 429,
    description: 'Cooldown, exhausted or email limit',
  })
  resend(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
  ) {
    return this.deletion.resendChallenge(actor, target, body);
  }

  /**
   * `@Replay`: a retry with a key already accepted for this user is answered before the session
   * check, because the account is `deleting` and can no longer authenticate (spec 1.6 §1.3.2).
   */
  @Post('deletion-confirm')
  @HttpCode(202)
  @RequirePermission('users', 'delete')
  @Replay('deletion_confirm')
  @ApiOperation({ summary: 'Confirm your own deletion and get a receipt' })
  @ApiHeader(KEY_HEADER)
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['challengeId', 'code'],
          additionalProperties: false,
          properties: {
            challengeId: { type: 'string', format: 'uuid' },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
        },
        {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', maxLength: 200 } },
        },
      ],
    },
  })
  @ApiAcceptedResponse({ schema: RECEIPT })
  @ApiResponse({
    status: 409,
    description: 'Key used for another target, or the last RBAC manager',
  })
  @ApiResponse({ status: 429, description: 'OTP attempts exhausted' })
  async confirm(
    @Req() request: FastifyRequest,
    @Param('userId') target: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const receipt = await this.deletion.confirm(
      request.authUserId,
      target,
      key,
      body,
    );
    // Step 12: the account no longer authenticates; drop its cookies with their original attributes.
    this.cookies.clear(reply);
    return receipt;
  }

  @Delete()
  @HttpCode(202)
  @RequirePermission('users', 'delete')
  @ApiOperation({
    summary:
      "Delete someone else's account (users@delete_any); retries a failed job",
  })
  @ApiHeader(KEY_HEADER)
  @ApiAcceptedResponse({ schema: RECEIPT })
  @ApiResponse({
    status: 404,
    description: 'Target not found after permissions',
  })
  @ApiResponse({
    status: 409,
    description: 'Key used for another target, or the last RBAC manager',
  })
  remove(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    assertNoBody(body, request.headers);
    return this.deletion.adminDelete(actor, target, key);
  }

  /**
   * With `Deletion-Receipt` the self branch runs and the cookie is not read; without it, the admin
   * branch needs `users@delete` (the pair) and `users@delete_any` (spec 1.6 §1.3.4).
   */
  @Get('deletion-status')
  @Receipt('Deletion-Receipt')
  @RequirePermission('users', 'delete')
  @RateLimit('deletion_status_ip')
  @ApiOperation({ summary: 'Deletion job status, by receipt or as an admin' })
  @ApiHeader({
    name: 'Deletion-Receipt',
    required: false,
    description: 'The jobId (self branch). Without it the admin branch runs.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'failed'],
        },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        finishedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Unknown target, job or receipt' })
  @ApiResponse({ status: 429, description: '60 requests per IP per minute' })
  status(
    @Req() request: FastifyRequest,
    @Param('userId') target: string,
    @Headers('deletion-receipt') receipt: unknown,
  ) {
    return this.deletion.status(request.authUserId, target, receipt);
  }
}
