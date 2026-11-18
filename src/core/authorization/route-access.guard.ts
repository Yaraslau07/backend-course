import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';
import { getRouteRateLimits } from '@/core/rate-limit/rate-limit.decorator';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { AccessAuthenticator } from '@/modules/auth/access-authenticator';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

import { CsrfPolicy } from './csrf';
import { IdempotentReplays } from './idempotent-replay';
import { getRouteAccess } from './route-access';

/**
 * The first step of every request (registered globally). It reads the route's declaration and
 * decides which branch applies: public and internal routes get CSRF and IP limits; a receipt with
 * its header goes to the handler, which checks it; everything else runs the protected chain
 * (`protectedChain`, spec 1.3). A missing or broken declaration fails closed with 503.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('Authorization');

  constructor(
    private readonly csrf: CsrfPolicy,
    private readonly limiter: RateLimiter,
    private readonly authenticator: AccessAuthenticator,
    private readonly authorizer: RbacAuthorizer,
    private readonly replays: IdempotentReplays,
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
        if (
          access.replay &&
          (await this.isReplay(context, request, access.replay))
        )
          return true;
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
   * 3. the route's user limits (by the verified id), then its IP limits (429): one user past their
   *    own limit doesn't fill the IP budget others behind the same address share (D50);
   * 4. RBAC (403, or 503 without a current policy).
   * The resource and ownership step then belongs to the handler (`Ownership`, D48).
   */
  private async protectedChain(
    context: ExecutionContext,
    request: FastifyRequest,
    pair: { permission: string; action: string },
  ): Promise<true> {
    const operation = this.handlerName(context);
    const userId = await this.authenticator.authenticate(request, operation);
    this.csrf.assert(request, operation);
    for (const policy of getRouteRateLimits(context.getHandler()).user) {
      await this.limiter.enforce(policy, [userId]);
    }
    await this.enforceIpLimits(context, request);
    await this.authorizer.authorize(
      userId,
      pair.permission,
      pair.action,
      operation,
    );
    return true;
  }

  /**
   * Spec 1.6 §1.3.2 step 2: an idempotent retry of an accepted operation is answered before the
   * session is checked (the account may no longer authenticate). It gets the receipt branch's CSRF
   * and IP limits; a key that belongs to another target is a 409; anything else runs the chain.
   */
  private async isReplay(
    context: ExecutionContext,
    request: FastifyRequest,
    name: string,
  ): Promise<boolean> {
    const verdict = await this.replays.check(name, request);
    if (verdict === 'none') return false;
    this.csrf.assert(request, this.handlerName(context));
    await this.enforceIpLimits(context, request);
    if (verdict === 'conflict') throw new AppException('idempotency_conflict');
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
