import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';

import { CsrfPolicy } from './csrf';
import { getRouteRateLimits } from '@/core/rate-limit/rate-limit.decorator';

import { getRouteAccess } from './route-access';

/**
 * The first step of every request (registered globally). It reads the route's declaration and
 * decides which branch applies, checking CSRF on writes that don't go through the session chain. Until the authorization chain lands (C11), the protected branch
 * fails closed: no handler that needs a permission can run before RBAC exists.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('Authorization');

  constructor(
    private readonly csrf: CsrfPolicy,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const access = getRouteAccess(context.getHandler());
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    switch (access.kind) {
      case 'public':
      case 'internal':
        // Public writes (login, registration, refresh, logout) are CSRF-checked too (spec 1.2).
        this.csrf.assert(request, this.handlerName(context));
        await this.enforceIpLimits(context, request);
        return true;

      case 'receipt': {
        const value = request.headers[access.header];
        // With the header, the handler verifies the receipt; the cookie is not read at all.
        if (typeof value === 'string' && value.length > 0) {
          this.csrf.assert(request, this.handlerName(context));
          await this.enforceIpLimits(context, request);
          return true;
        }
        // Without it, a receipt-only route has no other way to know the caller.
        if (!access.pair) throw new AppException('invalid_session');
        return this.protectedChain(context);
      }

      case 'protected':
        return this.protectedChain(context);

      case 'invalid':
        this.logger.error(
          {
            category: 'route_configuration',
            handler: this.handlerName(context),
            reason: access.reason,
          },
          'request to a route without a valid access declaration',
        );
        throw new AppException('authorization_unavailable');
    }
  }

  /**
   * Replaced in C11 by access → active user → CSRF → IP and user rate limits → RBAC. CSRF and the
   * limits belong after identity there (spec 1.3 step 5), so neither is checked here: the branch
   * refuses every request anyway.
   */
  private protectedChain(context: ExecutionContext): never {
    this.logger.warn(
      {
        category: 'authorization_chain',
        handler: this.handlerName(context),
      },
      'protected route refused: the authorization chain is not wired yet',
    );
    throw new AppException('authorization_unavailable');
  }

  /**
   * After CSRF, so a refused cross-origin write doesn't use up the real client's budget.
   * `request.ip` honours TRUST_PROXY: behind a trusted proxy it is the forwarded client.
   */
  private async enforceIpLimits(
    context: ExecutionContext,
    request: FastifyRequest,
  ): Promise<void> {
    for (const policy of getRouteRateLimits(context.getHandler()).ip) {
      await this.limiter.enforce(policy, [request.ip]);
    }
  }

  private handlerName(context: ExecutionContext): string {
    return `${context.getClass().name}.${context.getHandler().name}`;
  }
}
