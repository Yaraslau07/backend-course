import {
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuthorizationModule } from '@/core/authorization/authorization.module';
import { CurrentUserId } from '@/core/authorization/current-user';
import { Ownership } from '@/core/authorization/ownership';
import {
  Internal,
  Public,
  Receipt,
  RequirePermission,
} from '@/core/authorization/route-access';
import { AppException } from '@/core/errors/app.exception';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';

/** How many times each probe handler actually ran; a refused request must leave it unchanged. */
export const calls: Record<string, number> = {};
const ran = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
  return { ran: name };
};

/** Test-only routes with every kind of declaration, valid and broken. */
@Controller('__routes')
class RouteProbeController {
  @Get('public')
  @Public()
  publicRoute() {
    return ran('public');
  }

  @Post('public')
  @Public()
  publicWrite() {
    return ran('public-write');
  }

  @Get('internal')
  @Internal()
  internalRoute() {
    return ran('internal');
  }

  @Get('protected')
  @RequirePermission('probe', 'read')
  protectedRoute() {
    return ran('protected');
  }

  @Post('protected')
  @RequirePermission('probe', 'write')
  protectedWrite() {
    return ran('protected-write');
  }

  @Get('receipt')
  @Receipt('Probe-Receipt')
  receiptOnly() {
    return ran('receipt');
  }

  @Get('receipt-or-pair')
  @Receipt('Probe-Receipt')
  @RequirePermission('probe', 'read')
  receiptOrPair() {
    return ran('receipt-or-pair');
  }

  /** 30 per minute per IP (the refresh policy, borrowed for the probe). */
  @Post('limited')
  @Public()
  @RateLimit('refresh_ip')
  limited() {
    return ran('limited');
  }

  @Get('user-limit-on-public')
  @Public()
  @RateLimit('users_list_user')
  userLimitOnPublic() {
    return ran('user-limit-on-public');
  }

  @Get('missing')
  missing() {
    return ran('missing');
  }

  @Get('public-and-pair')
  @Public()
  @RequirePermission('probe', 'read')
  publicAndPair() {
    return ran('public-and-pair');
  }

  @Get('two-pairs')
  @RequirePermission('probe', 'read')
  @RequirePermission('probe', 'write')
  twoPairs() {
    return ran('two-pairs');
  }

  @Get('bad-name')
  @RequirePermission('probe', 'read everything')
  badName() {
    return ran('bad-name');
  }
}

/** A protected resource with an owner, run through the ownership step like a real handler (C12). */
@Controller('__routes')
class OwnershipProbeController {
  constructor(
    private readonly ownership: Ownership,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  @Get('owned/:userId')
  @RequirePermission('probe', 'read')
  async owned(
    @CurrentUserId() actor: string,
    @Param('userId', new ParseUUIDPipe()) target: string,
  ) {
    const scope = await this.ownership.selfOr(
      actor,
      target,
      'probe',
      'read_any',
      'OwnershipProbeController.owned',
    );
    // Only now is the target looked up: a 404 is possible only for someone allowed to search.
    ran('owned-lookup');
    const [row] = await this.db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE id = $1`,
      [target],
    );
    if (!row) throw new AppException('not_found');
    return { scope };
  }

  /** 60 per user per minute (the users-list policy, borrowed for the probe). */
  @Get('user-limited')
  @RequirePermission('probe', 'read')
  @RateLimit('users_list_user')
  userLimited() {
    return ran('user-limited');
  }
}

@Module({
  imports: [AuthorizationModule],
  controllers: [RouteProbeController, OwnershipProbeController],
})
export class RouteProbeModule {}

/** The broken routes above, as the startup scan reports them. */
export const INVALID_PROBE_ROUTES = [
  { route: 'GET /__routes/missing', reason: 'missing' },
  { route: 'GET /__routes/public-and-pair', reason: 'conflict' },
  { route: 'GET /__routes/two-pairs', reason: 'conflict' },
  { route: 'GET /__routes/bad-name', reason: 'invalid_name' },
  {
    route: 'GET /__routes/user-limit-on-public',
    reason: 'user_limit_without_session',
  },
];
