import type { ExecutionContext } from '@nestjs/common';

import { AppException } from '@/core/errors/app.exception';

import { Internal, Public, Receipt, RequirePermission } from './route-access';
import { RouteAccessGuard } from './route-access.guard';

class Handlers {
  @Public()
  publicRoute() {}

  @Internal()
  internalRoute() {}

  @RequirePermission('users', 'read')
  protectedRoute() {}

  @Receipt('Deletion-Receipt')
  receiptOnly() {}

  @Receipt('Deletion-Receipt')
  @RequirePermission('users', 'delete')
  receiptOrPair() {}

  undeclared() {}

  @Public()
  @RequirePermission('users', 'read')
  conflicting() {}
}

function contextFor(
  handler: keyof Handlers,
  headers: Record<string, string> = {},
  type = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function rejection(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return undefined;
}

describe('RouteAccessGuard', () => {
  const guard = new RouteAccessGuard();

  it('lets public and internal routes through without any session', () => {
    expect(guard.canActivate(contextFor('publicRoute'))).toBe(true);
    expect(guard.canActivate(contextFor('internalRoute'))).toBe(true);
  });

  it('fails closed on a protected route until the authorization chain exists', () => {
    expect(
      rejection(() => guard.canActivate(contextFor('protectedRoute'))),
    ).toBe('authorization_unavailable');
  });

  it('fails closed on an undeclared or conflicting route', () => {
    expect(rejection(() => guard.canActivate(contextFor('undeclared')))).toBe(
      'authorization_unavailable',
    );
    expect(rejection(() => guard.canActivate(contextFor('conflicting')))).toBe(
      'authorization_unavailable',
    );
  });

  it('hands a receipt route to its handler when the header is present', () => {
    const headers = { 'deletion-receipt': 'a'.repeat(32) };
    expect(guard.canActivate(contextFor('receiptOnly', headers))).toBe(true);
    expect(guard.canActivate(contextFor('receiptOrPair', headers))).toBe(true);
  });

  it('treats an empty receipt header as absent', () => {
    expect(
      rejection(() =>
        guard.canActivate(
          contextFor('receiptOnly', { 'deletion-receipt': '' }),
        ),
      ),
    ).toBe('invalid_session');
  });

  it('without the header, a receipt-only route has no way to identify the caller (401)', () => {
    expect(rejection(() => guard.canActivate(contextFor('receiptOnly')))).toBe(
      'invalid_session',
    );
  });

  it('without the header, a receipt route with a pair follows the protected chain', () => {
    expect(
      rejection(() => guard.canActivate(contextFor('receiptOrPair'))),
    ).toBe('authorization_unavailable');
  });

  it('ignores non-HTTP contexts', () => {
    expect(guard.canActivate(contextFor('undeclared', {}, 'rpc'))).toBe(true);
  });
});
