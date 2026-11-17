import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { AccessAuthenticator } from '@/modules/auth/access-authenticator';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

import { CsrfPolicy } from './csrf';
import { getRouteRateLimits } from '@/core/rate-limit/rate-limit.decorator';

import { getRouteAccess } from './route-access';

/**
 * The first step of every request (registered globally). It reads the route's declaration and
 * decides which branch applies, checking CSRF on writes that don't go through the session chain.
 * The protected branch authenticates first (spec 1.2 §1.3.6); until the rest of the chain lands
 * (C11) it then fails closed: no handler that needs a permission can run before RBAC exists.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('Authorization');

  constructor(
    private readonly csrf: CsrfPolicy,
    private readonly limiter: RateLimiter,
    private readonly authenticator: AccessAuthenticator,
    private readonly authorizer: RbacAuthorizer,
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
        return this.protectedChain(context, request, access.pair);
      }

      case 'protected':
        return this.protectedChain(context, request, access);

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
   * Spec 1.3 §1.3.1 and §1.6, in this order:
   * 1. access → active user (the authenticator: 401, or 503 if the user can't be read);
   * 2. CSRF on writes, after identity (D28);
   * 3. the route's IP and user limits (429), by `request.ip` and the verified user id;
   * 4. RBAC (403, or 503 without a current policy).
   * The resource and ownership step then belongs to the handler (`Ownership`, D48).
   */
  private async protectedChain(
    context: ExecutionContext,
    request: FastifyRequest,
    pair: { permission: string; action: string },
  ): Promise<true> {
    const operation = this.handlerName(context);
    const userId = await this.authenticator.authenticate(request);
    this.csrf.assert(request, operation);
    await this.enforceIpLimits(context, request);
    for (const policy of getRouteRateLimits(context.getHandler()).user) {
      await this.limiter.enforce(policy, [userId]);
    }
    await this.authorizer.authorize(
      userId,
      pair.permission,
      pair.action,
      operation,
    );
    return true;
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
