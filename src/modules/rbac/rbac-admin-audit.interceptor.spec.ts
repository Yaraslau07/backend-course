import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Logger,
} from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';

import { AppException } from '@/core/errors/app.exception';

import { RbacAdminAuditInterceptor } from './rbac-admin-audit.interceptor';
import { RBAC_LOGGED_ERRORS } from './rbac-admin.service';
import type { RbacPolicyStore } from './rbac-policy.store';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ROLE = '22222222-2222-4222-8222-222222222222';

function context(
  url: string,
  params: Record<string, string>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url, params, authUserId: ACTOR }),
    }),
    getHandler: () => ({ name: 'replaceRole' }),
  } as unknown as ExecutionContext;
}
const failing = (error: unknown): CallHandler => ({
  handle: () => throwError(() => error),
});

const fieldsAt = (spy: jest.SpyInstance, n: number) =>
  (spy.mock.calls[n] as [Record<string, unknown>])[0];

describe('RbacAdminAuditInterceptor (spec 1.1 §1.5)', () => {
  let warn: jest.SpyInstance;
  const interceptor = new RbacAdminAuditInterceptor({
    loadedVersion: () => '7',
  } as unknown as RbacPolicyStore);
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const run = (error: unknown, url = `/admin/rbac/roles/${ROLE}?x=1`) =>
    lastValueFrom(
      interceptor.intercept(context(url, { roleId: ROLE }), failing(error)),
    ).catch(() => undefined);

  it('logs a 400 raised before the service with actor, operation, entity, version and result', async () => {
    await run(new AppException('bad_request'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fieldsAt(warn, 0)).toEqual({
      event: 'rbac_change',
      actorUserId: ACTOR,
      operation: 'replaceRole',
      entityType: 'role',
      entityId: ROLE,
      version: '7',
      result: 'failure',
      errorCode: 'bad_request',
    });
  });

  it('marks an unavailable dependency, and maps each route to its entity type', async () => {
    await run(
      new AppException('authorization_unavailable'),
      '/admin/rbac/grants',
    );
    expect(fieldsAt(warn, 0)).toMatchObject({
      entityType: 'grant',
      category: 'dependency',
    });
    await run(new AppException('bad_request'), '/admin/rbac/users/x/roles');
    expect(fieldsAt(warn, 1)).toMatchObject({ entityType: 'user_roles' });
    await run(new AppException('bad_request'), '/admin/rbac/permissions/x');
    expect(fieldsAt(warn, 2)).toMatchObject({ entityType: 'permission' });
  });

  it('a framework 400 (a malformed path id) is a bad_request too', async () => {
    await run(new BadRequestException('Validation failed (uuid is expected)'));
    expect(fieldsAt(warn, 0)).toMatchObject({ errorCode: 'bad_request' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('uuid is expected');
  });

  it('does not log again what the service already logged', async () => {
    const logged = new AppException('conflict');
    RBAC_LOGGED_ERRORS.add(logged);
    await run(logged);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never logs the body or a description', async () => {
    await run(new AppException('bad_request'));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/description|body/);
  });
});
