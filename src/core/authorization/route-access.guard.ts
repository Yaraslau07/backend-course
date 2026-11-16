/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import type { CanActivate, ExecutionContext } from '@nestjs/common';

export class RouteAccessGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    throw new Error('not implemented');
  }
}
