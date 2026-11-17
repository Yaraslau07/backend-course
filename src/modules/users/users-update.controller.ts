import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';
import { AppException } from '@/core/errors/app.exception';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';
import { UsersUpdateService } from './users-update.service';
import { PHOTO_MAX_BYTES, type PhotoInput } from './photo-normalizer';
import { SafeProfileDto } from './dto/safe-profile.dto';
import { UsersUpdateAuditInterceptor } from './users-update-audit.interceptor';

export async function readPhotoMultipart(
  request: FastifyRequest,
): Promise<PhotoInput> {
  if (!request.isMultipart()) throw new AppException('unsupported_media_type');
  let file: PhotoInput | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file' || file)
        throw new AppException('bad_request');
      const bytes = await part.toBuffer();
      if (part.file.truncated || bytes.length > PHOTO_MAX_BYTES)
        throw new AppException('payload_too_large');
      file = { bytes, mime: part.mimetype };
    }
    if (!file) throw new AppException('bad_request');
    return file;
  } catch (error: unknown) {
    if (error instanceof AppException) throw error;
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE'
    )
      throw new AppException('payload_too_large');
    throw new AppException('bad_request');
  }
}

@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiResponse({
  status: 400,
  description: 'Invalid body, path, file or challenge',
})
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({
  status: 403,
  description: 'Permission, ownership or CSRF denied',
})
@ApiResponse({ status: 404, description: 'Target not found after permissions' })
@ApiResponse({
  status: 409,
  description: 'Email conflict, noneditable target or last RBAC manager',
})
@ApiResponse({ status: 429, description: 'Change/email/cooldown limit' })
@ApiResponse({ status: 503, description: 'Dependency unavailable' })
@Controller('users/:userId')
@UseInterceptors(UsersUpdateAuditInterceptor)
export class UsersUpdateController {
  constructor(private readonly users: UsersUpdateService) {}
  @Patch()
  @RequirePermission('users', 'update')
  @RateLimit('user_update')
  @ApiOperation({
    summary: 'Patch allowed profile fields; email/status require update_any',
  })
  @ApiBody({
    schema: {
      type: 'object',
      minProperties: 1,
      maxProperties: 3,
      additionalProperties: false,
      properties: {
        displayName: { type: 'string', nullable: true },
        email: { type: 'string', format: 'email' },
        status: { type: 'string', enum: ['active', 'blocked'] },
      },
    },
  })
  @ApiOkResponse({ type: SafeProfileDto })
  patch(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
  ) {
    return this.users.patch(actor, target, body);
  }
  @Post('email-change')
  @HttpCode(202)
  @RequirePermission('users', 'update')
  @ApiOperation({
    summary: 'Start an email change to a new address (self only)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['newEmail'],
      additionalProperties: false,
      properties: { newEmail: { type: 'string', format: 'email' } },
    },
  })
  start(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
  ) {
    return this.users.startEmail(actor, target, body);
  }
  @Post('email-change/resend')
  @HttpCode(202)
  @RequirePermission('users', 'update')
  @ApiOperation({ summary: 'Resend an email change (self only)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['challengeId'],
      additionalProperties: false,
      properties: { challengeId: { type: 'string', format: 'uuid' } },
    },
  })
  resend(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
  ) {
    return this.users.resendEmail(actor, target, body);
  }
  @Post('email-change/confirm')
  @HttpCode(200)
  @RequirePermission('users', 'update')
  @ApiOperation({
    summary: 'Confirm an OTP or magic-link email change (self only)',
  })
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
  @ApiOkResponse({ type: SafeProfileDto })
  confirm(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
  ) {
    return this.users.confirmEmail(actor, target, body);
  }
  @Put('photo')
  @RequirePermission('users', 'update')
  @RateLimit('user_update')
  @ApiOperation({ summary: 'Normalize and replace a profile photo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      additionalProperties: false,
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: SafeProfileDto })
  @ApiResponse({ status: 413, description: 'File exceeds 5 MiB' })
  @ApiResponse({
    status: 415,
    description: 'Unsupported image type or MIME mismatch',
  })
  upload(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Req() request: FastifyRequest,
  ) {
    return this.users.upload(actor, target, () => readPhotoMultipart(request));
  }
  @Delete('photo')
  @HttpCode(204)
  @RequirePermission('users', 'update')
  @RateLimit('user_update')
  @ApiOperation({
    summary: 'Clear a photo reference and queue reliable deletion',
  })
  clear(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    if (
      body !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0 ||
      request.headers['transfer-encoding']
    )
      throw new AppException('bad_request');
    return this.users.clearPhoto(actor, target);
  }
}
