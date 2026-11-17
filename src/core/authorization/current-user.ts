import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';

/**
 * The verified user id the access check put on the request (spec 1.1 §1.3.1: "taken only from the
 * context after checking the access JWT"). Only for `@RequirePermission` routes; if it is missing,
 * the chain didn't run, so the request fails closed instead of acting for nobody.
 */
export function currentUserId(
  _data: unknown,
  context: ExecutionContext,
): string {
  // `authUserId` is declared on FastifyRequest by the access authenticator, which sets it.
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  if (!request.authUserId) {
    throw new AppException('authorization_unavailable');
  }
  return request.authUserId;
}

export const CurrentUserId = createParamDecorator(currentUserId);
