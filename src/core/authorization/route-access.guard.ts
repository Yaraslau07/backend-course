import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';

import { CsrfPolicy } from './csrf';
import { getRouteAccess } from './route-access';

/**
 * The first step of every request (registered globally). It reads the route's declaration and
 * decides which branch applies. Until the authorization chain lands (C11), the protected branch
 * fails closed: no handler that needs a permission can run before RBAC exists.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('Authorization');

  constructor(private readonly csrf: CsrfPolicy) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const access = getRouteAccess(context.getHandler());
    switch (access.kind) {
      case 'public':
      case 'internal':
        return true;

      case 'receipt': {
        const request = context.switchToHttp().getRequest<FastifyRequest>();
        const value = request.headers[access.header];
        // With the header, the handler verifies the receipt; the cookie is not read at all.
        if (typeof value === 'string' && value.length > 0) return true;
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

  /** Replaced by access → active user → CSRF → RBAC in C11. */
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

  private handlerName(context: ExecutionContext): string {
    return `${context.getClass().name}.${context.getHandler().name}`;
  }
}
