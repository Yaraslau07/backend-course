import { Logger } from '@nestjs/common';

import type {
  ReadinessCheck,
  ReadinessRegistry,
} from '@/core/health/readiness.registry';

import {
  type EraseResult,
  UserDataErasers,
  type UserDataEraser,
} from './user-data-erasers';

function setup(owners: string[]) {
  const checks = new Map<string, ReadinessCheck>();
  const readiness = {
    register: (name: string, check: ReadinessCheck) => checks.set(name, check),
  } as unknown as ReadinessRegistry;
  const erasers = new UserDataErasers(readiness, owners);
  erasers.onModuleInit();
  return { erasers, check: () => checks.get('user_data_erasers')!() };
}
const eraser = (
  owner: string,
  run: () => Promise<EraseResult>,
): UserDataEraser & { calls: jest.Mock } => {
  const calls = jest.fn(run);
  return { owner, eraseUserData: calls, calls };
};
const ok = () => Promise.resolve<EraseResult>({ result: 'succeeded' });

describe('UserDataErasers (spec 1.6 §1.3.5, §1.6)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('is not ready while a declared owner has no eraser', async () => {
    const { erasers, check } = setup(['profile', 'transformations']);
    erasers.register(eraser('profile', ok));
    expect(await check()).toEqual({ down: 'eraser_missing' });
    expect(erasers.missing()).toEqual(['transformations']);
    erasers.register(eraser('transformations', ok));
    expect(await check()).toBe('up');
  });

  it('refuses two erasers for one owner', () => {
    const { erasers } = setup(['profile']);
    erasers.register(eraser('profile', ok));
    expect(() => erasers.register(eraser('profile', ok))).toThrow();
  });

  it('does not run anything while an eraser is missing', async () => {
    const { erasers } = setup(['profile', 'other']);
    const first = eraser('profile', ok);
    erasers.register(first);
    expect(await erasers.eraseAll('u', 'j')).toEqual({
      result: 'retryable_failure',
      code: 'eraser_missing',
    });
    expect(first.calls).not.toHaveBeenCalled();
  });

  it('runs every eraser with the user and job ids, in order, and succeeds when all do', async () => {
    const { erasers } = setup(['a', 'b']);
    const a = eraser('a', ok);
    const b = eraser('b', ok);
    erasers.register(a);
    erasers.register(b);
    expect(await erasers.eraseAll('user-1', 'job-1')).toEqual({
      result: 'succeeded',
    });
    expect(a.calls).toHaveBeenCalledWith('user-1', 'job-1');
    expect(b.calls.mock.invocationCallOrder[0]).toBeGreaterThan(
      a.calls.mock.invocationCallOrder[0],
    );
  });

  it('stops at the first failure and passes its safe code on', async () => {
    const { erasers } = setup(['a', 'b']);
    const b = eraser('b', ok);
    erasers.register(
      eraser('a', () =>
        Promise.resolve<EraseResult>({
          result: 'permanent_failure',
          code: 'storage_refused',
        }),
      ),
    );
    erasers.register(b);
    expect(await erasers.eraseAll('u', 'j')).toEqual({
      result: 'permanent_failure',
      code: 'storage_refused',
    });
    expect(b.calls).not.toHaveBeenCalled();
  });

  it('turns a thrown error into a retryable failure, and an unsafe code into a fixed one', async () => {
    const { erasers } = setup(['a']);
    const a = eraser('a', () => Promise.reject(new Error('secret detail')));
    erasers.register(a);
    expect(await erasers.eraseAll('u', 'j')).toEqual({
      result: 'retryable_failure',
      code: 'eraser_error',
    });
    a.calls.mockImplementationOnce(() =>
      Promise.resolve<EraseResult>({
        result: 'retryable_failure',
        code: 'Connection to 10.0.0.1 refused',
      }),
    );
    expect(await erasers.eraseAll('u', 'j')).toEqual({
      result: 'retryable_failure',
      code: 'eraser_failed',
    });
  });
});
