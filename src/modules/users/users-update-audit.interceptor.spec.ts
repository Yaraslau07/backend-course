import { type ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { AppException } from '@/core/errors/app.exception';

import { UsersUpdateAuditInterceptor } from './users-update-audit.interceptor';

const context = (body: unknown) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        id: 'request-id',
        authUserId: 'verified-actor',
        params: { userId: 'allowed-target' },
        body,
      }),
    }),
    getHandler: () => function patch() {},
  }) as unknown as ExecutionContext;

describe('user change request audit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs only known field names, verified identity and the allowed target on success', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const audit = new UsersUpdateAuditInterceptor();
    const body = {
      displayName: 'private name',
      email: 'private@example.com',
      actorUserId: 'untrusted-id',
      'private-extra-key': 'value',
    };
    await lastValueFrom(
      audit.intercept(context(body), {
        handle: () => of({ email: body.email }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      {
        event: 'user_update_request',
        requestId: 'request-id',
        actorUserId: 'verified-actor',
        targetUserId: 'allowed-target',
        operation: 'patch',
        fields: ['displayName', 'email'],
        result: 'success',
      },
      expect.any(String),
    );
    const text = JSON.stringify(log.mock.calls);
    for (const value of [
      'private name',
      body.email,
      'untrusted-id',
      'private-extra-key',
    ])
      expect(text).not.toContain(value);
  });

  it.each([
    new AppException('bad_request'),
    new AppException('ownership_denied'),
    new Error('private storage detail'),
  ])(
    'logs refusals without target, body values or exception messages',
    async (error) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const audit = new UsersUpdateAuditInterceptor();
      await expect(
        lastValueFrom(
          audit.intercept(context({ displayName: 'private value' }), {
            handle: () => throwError(() => error),
          }),
        ),
      ).rejects.toBe(error);
      const entry = warn.mock.calls[0][0] as Record<string, unknown>;
      expect(entry).toMatchObject({
        event: 'user_update_request',
        actorUserId: 'verified-actor',
        result: 'failure',
        fields: ['displayName'],
        category: error instanceof AppException ? error.code : 'dependency',
      });
      expect(entry).not.toHaveProperty('targetUserId');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    },
  );
});
