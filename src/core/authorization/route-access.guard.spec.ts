import { type ExecutionContext, Logger } from '@nestjs/common';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { CsrfPolicy } from './csrf';

import { Internal, Public, Receipt, RequirePermission } from './route-access';
import { RouteAccessGuard } from './route-access.guard';

class Handlers {
  @Public()
  publicRoute() {}

  @Public()
  publicWrite() {}

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
  method = 'GET',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  } as unknown as ExecutionContext;
}

const csrf = new CsrfPolicy({
  get: (key: string) =>
    ({
      PUBLIC_API_BASE_URL: 'https://api.example.test',
      CORS_ORIGINS: ['https://app.example.test'],
    })[key],
} as unknown as ConfigService);
const EVIL = { origin: 'https://evil.test' };

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
  const guard = new RouteAccessGuard(csrf);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

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

  it('checks CSRF on a public write, since login and registration are public (spec 1.2 §1.3.3)', () => {
    expect(
      rejection(() =>
        guard.canActivate(contextFor('publicWrite', EVIL, 'http', 'POST')),
      ),
    ).toBe('csrf_rejected');
    expect(
      guard.canActivate(
        contextFor(
          'publicWrite',
          { origin: 'https://app.example.test', 'x-csrf-protection': '1' },
          'http',
          'POST',
        ),
      ),
    ).toBe(true);
  });

  it('does not check CSRF on a read', () => {
    expect(guard.canActivate(contextFor('publicRoute', EVIL))).toBe(true);
  });

  it('checks CSRF on a write that carries a receipt', () => {
    expect(
      rejection(() =>
        guard.canActivate(
          contextFor(
            'receiptOnly',
            { ...EVIL, 'deletion-receipt': 'r' },
            'http',
            'POST',
          ),
        ),
      ),
    ).toBe('csrf_rejected');
  });

  it('answers a protected write 503 before any CSRF check: CSRF comes after identity (spec 1.3)', () => {
    expect(
      rejection(() =>
        guard.canActivate(contextFor('protectedRoute', EVIL, 'http', 'POST')),
      ),
    ).toBe('authorization_unavailable');
  });

  it('ignores non-HTTP contexts', () => {
    expect(guard.canActivate(contextFor('undeclared', {}, 'rpc'))).toBe(true);
  });
});
