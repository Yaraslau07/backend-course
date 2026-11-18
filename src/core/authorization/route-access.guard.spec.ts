import { type ExecutionContext, Logger } from '@nestjs/common';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import type { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';
import type { AccessAuthenticator } from '@/modules/auth/access-authenticator';
import type { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

import { CsrfPolicy } from './csrf';

import { IdempotentReplays, type ReplayVerdict } from './idempotent-replay';
import {
  Internal,
  Public,
  Receipt,
  Replay,
  RequirePermission,
} from './route-access';
import { RouteAccessGuard } from './route-access.guard';

class Handlers {
  @Public()
  publicRoute() {}

  @Public()
  publicWrite() {}

  @Public()
  @RateLimit('login_ip', 'refresh_ip')
  limitedRoute() {}

  @Receipt('Deletion-Receipt')
  @RequirePermission('users', 'delete')
  @RateLimit('deletion_status_ip')
  limitedReceipt() {}

  @Internal()
  internalRoute() {}

  @RequirePermission('users', 'read')
  protectedRoute() {}

  @RequirePermission('users', 'list')
  @RateLimit('users_list_ip')
  protectedIpLimited() {}

  @RequirePermission('users', 'list')
  @RateLimit('users_list_user')
  protectedUserLimited() {}

  @RequirePermission('users', 'list')
  @RateLimit('users_list_ip', 'users_list_user')
  protectedBothLimited() {}

  @Receipt('Deletion-Receipt')
  receiptOnly() {}

  @Receipt('Deletion-Receipt')
  @RequirePermission('users', 'delete')
  receiptOrPair() {}

  @RequirePermission('users', 'delete')
  @Replay('probe_replay')
  replayable() {}

  @RequirePermission('users', 'delete')
  @Replay('unregistered_replay')
  replayWithoutMatcher() {}

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
    switchToHttp: () => ({
      getRequest: () => ({ method, headers, ip: '203.0.113.9' }),
    }),
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

async function rejection(
  run: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return undefined;
}

describe('RouteAccessGuard', () => {
  const enforce = jest.fn<Promise<void>, [string, string[]]>();
  const limiter = { enforce } as unknown as RateLimiter;
  const authenticate = jest.fn<Promise<string>, [unknown]>();
  const authenticator = { authenticate } as unknown as AccessAuthenticator;
  const authorize = jest.fn<Promise<void>, [string, string, string]>();
  const authorizer = { authorize } as unknown as RbacAuthorizer;
  const replays = new IdempotentReplays();
  const verdict = jest.fn<Promise<ReplayVerdict>, [unknown]>();
  replays.register('probe_replay', verdict);
  const guard = new RouteAccessGuard(
    csrf,
    limiter,
    authenticator,
    authorizer,
    replays,
  );
  const USER = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';

  beforeEach(() => {
    enforce.mockReset().mockResolvedValue(undefined);
    authenticate.mockReset().mockResolvedValue(USER);
    authorize.mockReset().mockResolvedValue(undefined);
    verdict.mockReset().mockResolvedValue('none');
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('idempotent replay (spec 1.6 §1.3.2 step 2)', () => {
    it('answers a recognised replay before the session check, with CSRF and IP limits', async () => {
      verdict.mockResolvedValueOnce('replay');
      expect(
        await guard.canActivate(contextFor('replayable', {}, 'http', 'POST')),
      ).toBe(true);
      expect(authenticate).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

    it('refuses a key that belongs to another target with 409, and a cross-origin replay with 403', async () => {
      verdict.mockResolvedValueOnce('conflict');
      expect(
        await rejection(() =>
          guard.canActivate(contextFor('replayable', {}, 'http', 'POST')),
        ),
      ).toBe('idempotency_conflict');
      verdict.mockResolvedValueOnce('replay');
      expect(
        await rejection(() =>
          guard.canActivate(contextFor('replayable', EVIL, 'http', 'POST')),
        ),
      ).toBe('csrf_rejected');
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('runs the full chain when the matcher finds nothing or is not registered', async () => {
      expect(await guard.canActivate(contextFor('replayable'))).toBe(true);
      expect(await guard.canActivate(contextFor('replayWithoutMatcher'))).toBe(
        true,
      );
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenCalledTimes(2);
    });

    it('refuses a second matcher under the same name', () => {
      expect(() => replays.register('probe_replay', verdict)).toThrow();
    });
  });

  it('lets public and internal routes through without any session', async () => {
    expect(await guard.canActivate(contextFor('publicRoute'))).toBe(true);
    expect(await guard.canActivate(contextFor('internalRoute'))).toBe(true);
  });

  it('authenticates, then asks RBAC for the declared pair with the verified user id', async () => {
    expect(await guard.canActivate(contextFor('protectedRoute'))).toBe(true);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(
      USER,
      'users',
      'read',
      'Handlers.protectedRoute',
    );
  });

  it('passes the RBAC refusal on (403, or 503 when the policy is unavailable)', async () => {
    authorize.mockRejectedValueOnce(new AppException('permission_denied'));
    expect(
      await rejection(() => guard.canActivate(contextFor('protectedRoute'))),
    ).toBe('permission_denied');

    authorize.mockRejectedValueOnce(
      new AppException('authorization_unavailable'),
    );
    expect(
      await rejection(() => guard.canActivate(contextFor('protectedRoute'))),
    ).toBe('authorization_unavailable');
  });

  it('does not ask RBAC when authentication fails', async () => {
    authenticate.mockRejectedValueOnce(new AppException('invalid_session'));
    await rejection(() => guard.canActivate(contextFor('protectedRoute')));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('checks CSRF on a protected write after identity and before RBAC (spec 1.3)', async () => {
    expect(
      await rejection(() =>
        guard.canActivate(contextFor('protectedRoute', EVIL, 'http', 'POST')),
      ),
    ).toBe('csrf_rejected');
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('enforces IP limits on a protected route after CSRF, before RBAC', async () => {
    expect(await guard.canActivate(contextFor('protectedIpLimited'))).toBe(
      true,
    );
    expect(enforce).toHaveBeenCalledWith('users_list_ip', ['203.0.113.9']);
  });

  it('enforces a user-keyed limit by the verified user id, after CSRF and before RBAC', async () => {
    expect(await guard.canActivate(contextFor('protectedUserLimited'))).toBe(
      true,
    );
    expect(enforce).toHaveBeenCalledWith('users_list_user', [USER]);
    expect(enforce.mock.invocationCallOrder[0]).toBeLessThan(
      authorize.mock.invocationCallOrder[0],
    );
  });

  it('counts the user limit before the IP limit, so a user past their own limit spends no shared IP budget', async () => {
    enforce.mockRejectedValueOnce(new AppException('too_many_requests'));

    expect(
      await rejection(() =>
        guard.canActivate(contextFor('protectedBothLimited')),
      ),
    ).toBe('too_many_requests');
    expect(enforce.mock.calls).toEqual([['users_list_user', [USER]]]);
  });

  it('stops at an exceeded user limit: 429, RBAC not asked', async () => {
    enforce.mockRejectedValueOnce(new AppException('too_many_requests'));

    expect(
      await rejection(() =>
        guard.canActivate(contextFor('protectedUserLimited')),
      ),
    ).toBe('too_many_requests');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not count a protected write that CSRF refused against the user limit', async () => {
    await rejection(() =>
      guard.canActivate(
        contextFor('protectedUserLimited', EVIL, 'http', 'POST'),
      ),
    );
    expect(enforce).not.toHaveBeenCalled();
  });

  it('answers a protected route with the authenticator refusal (401, or 503 with the DB down)', async () => {
    authenticate.mockRejectedValueOnce(new AppException('invalid_session'));
    expect(
      await rejection(() => guard.canActivate(contextFor('protectedRoute'))),
    ).toBe('invalid_session');

    authenticate.mockRejectedValueOnce(
      new AppException('authorization_unavailable'),
    );
    expect(
      await rejection(() => guard.canActivate(contextFor('protectedRoute'))),
    ).toBe('authorization_unavailable');
  });

  it('never authenticates on public, internal or receipt-carrying routes', async () => {
    await guard.canActivate(contextFor('publicRoute'));
    await guard.canActivate(contextFor('internalRoute'));
    await guard.canActivate(
      contextFor('receiptOrPair', { 'deletion-receipt': 'a'.repeat(32) }),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('fails closed on an undeclared or conflicting route', async () => {
    expect(
      await rejection(() => guard.canActivate(contextFor('undeclared'))),
    ).toBe('authorization_unavailable');
    expect(
      await rejection(() => guard.canActivate(contextFor('conflicting'))),
    ).toBe('authorization_unavailable');
  });

  it('hands a receipt route to its handler when the header is present', async () => {
    const headers = { 'deletion-receipt': 'a'.repeat(32) };
    expect(await guard.canActivate(contextFor('receiptOnly', headers))).toBe(
      true,
    );
    expect(await guard.canActivate(contextFor('receiptOrPair', headers))).toBe(
      true,
    );
  });

  it('treats an empty receipt header as absent', async () => {
    expect(
      await rejection(() =>
        guard.canActivate(
          contextFor('receiptOnly', { 'deletion-receipt': '' }),
        ),
      ),
    ).toBe('invalid_session');
  });

  it('without the header, a receipt-only route has no way to identify the caller (401)', async () => {
    expect(
      await rejection(() => guard.canActivate(contextFor('receiptOnly'))),
    ).toBe('invalid_session');
  });

  it('without the header, a receipt route with a pair follows the protected chain', async () => {
    expect(await guard.canActivate(contextFor('receiptOrPair'))).toBe(true);
    expect(authorize).toHaveBeenCalledWith(
      USER,
      'users',
      'delete',
      'Handlers.receiptOrPair',
    );

    authenticate.mockRejectedValueOnce(new AppException('invalid_session'));
    expect(
      await rejection(() => guard.canActivate(contextFor('receiptOrPair'))),
    ).toBe('invalid_session');
  });

  it('checks CSRF on a public write, since login and registration are public (spec 1.2 §1.3.3)', async () => {
    expect(
      await rejection(() =>
        guard.canActivate(contextFor('publicWrite', EVIL, 'http', 'POST')),
      ),
    ).toBe('csrf_rejected');
    expect(
      await guard.canActivate(
        contextFor(
          'publicWrite',
          { origin: 'https://app.example.test', 'x-csrf-protection': '1' },
          'http',
          'POST',
        ),
      ),
    ).toBe(true);
  });

  it('does not check CSRF on a read', async () => {
    expect(await guard.canActivate(contextFor('publicRoute', EVIL))).toBe(true);
  });

  it('checks CSRF on a write that carries a receipt', async () => {
    expect(
      await rejection(() =>
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

  it('authenticates a protected write before any CSRF check: CSRF comes after identity (spec 1.3)', async () => {
    authenticate.mockRejectedValueOnce(new AppException('invalid_session'));
    expect(
      await rejection(() =>
        guard.canActivate(contextFor('protectedRoute', EVIL, 'http', 'POST')),
      ),
    ).toBe('invalid_session');
  });

  it('enforces the route IP limits by request.ip after CSRF, before the handler', async () => {
    expect(await guard.canActivate(contextFor('limitedRoute'))).toBe(true);

    expect(enforce.mock.calls).toEqual([
      ['login_ip', ['203.0.113.9']],
      ['refresh_ip', ['203.0.113.9']],
    ]);
  });

  it('does not count a request that CSRF already refused', async () => {
    await rejection(() =>
      guard.canActivate(contextFor('limitedRoute', EVIL, 'http', 'POST')),
    );

    expect(enforce).not.toHaveBeenCalled();
  });

  it('stops at the first exceeded limit', async () => {
    enforce.mockRejectedValueOnce(new AppException('too_many_requests'));

    expect(
      await rejection(() => guard.canActivate(contextFor('limitedRoute'))),
    ).toBe('too_many_requests');
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it('enforces IP limits on the receipt branch too', async () => {
    expect(
      await guard.canActivate(
        contextFor('limitedReceipt', { 'deletion-receipt': 'r' }),
      ),
    ).toBe(true);
    expect(enforce).toHaveBeenCalledWith('deletion_status_ip', ['203.0.113.9']);
  });

  it('ignores non-HTTP contexts', async () => {
    expect(await guard.canActivate(contextFor('undeclared', {}, 'rpc'))).toBe(
      true,
    );
  });
});
