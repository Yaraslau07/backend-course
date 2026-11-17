import { Logger } from '@nestjs/common';

import { AppException } from '@/core/errors/app.exception';
import type { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

import { Ownership } from './ownership';

/** Spec 1.3 §1.3.4 and spec 1.4 §1.3.1 steps 4–5: self passes, foreign needs the `_any` action. */
const ME = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const OTHER = '9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d';

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('Ownership', () => {
  const allows = jest.fn<Promise<boolean>, [string, string, string, string]>();
  const ownership = new Ownership({ allows } as unknown as RbacAuthorizer);
  let warn: jest.SpyInstance;

  beforeEach(() => {
    allows.mockReset();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('lets the caller act on their own id without asking RBAC again', async () => {
    expect(await ownership.selfOr(ME, ME, 'users', 'read_any', 'op')).toBe(
      'self',
    );
    expect(allows).not.toHaveBeenCalled();
  });

  it('lets a foreign id through when the caller has the `_any` action', async () => {
    allows.mockResolvedValue(true);

    expect(await ownership.selfOr(ME, OTHER, 'users', 'read_any', 'op')).toBe(
      'foreign',
    );
    expect(allows).toHaveBeenCalledWith(ME, 'users', 'read_any', 'op');
  });

  it('refuses a foreign id without the `_any` action: 403 ownership_denied, logged without the target', async () => {
    allows.mockResolvedValue(false);

    expect(
      await codeOf(() =>
        ownership.selfOr(ME, OTHER, 'users', 'read_any', 'op'),
      ),
    ).toBe('ownership_denied');
    expect((warn.mock.calls as unknown[][])[0][0]).toMatchObject({
      event: 'ownership',
      result: 'denied',
      category: 'ownership_denied',
      actorUserId: ME,
      operation: 'op',
      permission: 'users',
      action: 'read_any',
    });
    // The target isn't known to exist yet, so it is not logged (spec 1.3 §1.5).
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OTHER);
  });

  it('passes RBAC unavailability on (503, never a 403)', async () => {
    allows.mockRejectedValue(new AppException('authorization_unavailable'));

    expect(
      await codeOf(() =>
        ownership.selfOr(ME, OTHER, 'users', 'read_any', 'op'),
      ),
    ).toBe('authorization_unavailable');
  });

  it('accepts the owner of a loaded resource', () => {
    expect(() => ownership.assertOwner(ME, ME, 'op')).not.toThrow();
  });

  it('refuses someone else’s loaded resource with 403 ownership_denied', () => {
    expect(() => ownership.assertOwner(ME, OTHER, 'op')).toThrow(
      expect.objectContaining({ code: 'ownership_denied' }) as Error,
    );
  });
});
