import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConfigService } from '@/core/config/config.service';

import { ReadinessReport, ReadinessRegistry } from './readiness.registry';

/** "::ffff:127.0.0.1" (IPv4-mapped IPv6) is the same client as "127.0.0.1". */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly registry: ReadinessRegistry,
    private readonly config: ConfigService,
  ) {}

  /** Public liveness: the process is up. Touches no dependency, so a DB outage never restarts the container. */
  @Get('live')
  @HttpCode(200)
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Internal readiness: every registered check must be up. Only infrastructure may call it
   * (READINESS_ALLOWED_IPS); everyone else gets 404, as if the route did not exist.
   */
  @Get('ready')
  @ApiExcludeEndpoint()
  async ready(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReadinessReport> {
    const allowed = this.config.get('READINESS_ALLOWED_IPS').map(normalizeIp);
    if (!allowed.includes(normalizeIp(req.ip))) {
      throw new NotFoundException();
    }

    const report = await this.registry.run();
    reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
