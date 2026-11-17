import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';

import { UsersReadService } from './users-read.service';
import { SafeProfileDto, UserListPageDto } from './dto/safe-profile.dto';

@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiResponse({ status: 401, description: 'Missing or invalid session' })
@ApiResponse({ status: 403, description: 'Permission or ownership denied' })
@ApiResponse({ status: 429, description: 'Rate limit exceeded' })
@ApiResponse({ status: 503, description: 'Dependency unavailable' })
@Controller()
export class UsersReadController {
  constructor(private readonly users: UsersReadService) {}

  @Get('users/:userId')
  @ApiOkResponse({ type: SafeProfileDto })
  @ApiResponse({ status: 400, description: 'Invalid user ID format' })
  @RequirePermission('users', 'read')
  @ApiOperation({
    summary:
      'Read the canonical safe profile; foreign targets also need users@read_any',
  })
  @ApiParam({
    name: 'userId',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  })
  @ApiResponse({
    status: 404,
    description: 'User not found after permission checks',
  })
  profile(@CurrentUserId() actor: string, @Param('userId') target: string) {
    return this.users.profile(actor, target);
  }

  @Get('users/:userId/photo')
  @ApiParam({
    name: 'userId',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  })
  @ApiResponse({ status: 400, description: 'Invalid user ID format' })
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @Header('Cache-Control', 'private, max-age=300')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('users', 'read')
  @ApiOperation({ summary: 'Stream a protected normalized profile photo' })
  @ApiProduces('image/webp')
  @ApiResponse({ status: 404, description: 'User or photo not found' })
  async photo(
    @CurrentUserId() actor: string,
    @Param('userId') target: string,
  ): Promise<StreamableFile> {
    const stream = await this.users.photo(actor, target);
    return new StreamableFile(stream, { type: 'image/webp' });
  }

  @Get('admin/users')
  @ApiOkResponse({ type: UserListPageDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid/duplicate query parameter or invalid_cursor',
  })
  @RequirePermission('users', 'list')
  @RateLimit('users_list_user', 'users_list_ip')
  @ApiOperation({
    summary: 'List safe user profiles with signed keyset pagination',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'searchBy',
    required: false,
    enum: ['id', 'email', 'displayName'],
  })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'active', 'blocked', 'deleting', 'deleted'],
  })
  @ApiQuery({ name: 'sort', required: false, enum: ['createdAt', 'id'] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  list(@CurrentUserId() actor: string, @Query() query: unknown) {
    return this.users.list(actor, query);
  }
}
