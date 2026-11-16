import { Controller, Get, Module, Post } from '@nestjs/common';

import {
  Internal,
  Public,
  Receipt,
  RequirePermission,
} from '@/core/authorization/route-access';

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

@Module({ controllers: [RouteProbeController] })
export class RouteProbeModule {}

/** The broken routes above, as the startup scan reports them. */
export const INVALID_PROBE_ROUTES = [
  { route: 'GET /__routes/missing', reason: 'missing' },
  { route: 'GET /__routes/public-and-pair', reason: 'conflict' },
  { route: 'GET /__routes/two-pairs', reason: 'conflict' },
  { route: 'GET /__routes/bad-name', reason: 'invalid_name' },
];
