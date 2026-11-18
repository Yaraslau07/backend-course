import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import type { ObjectStorage } from '@/modules/storage/object-storage';
import type {
  EraseResult,
  UserDataErasers,
} from '@/modules/erasure/user-data-erasers';

import {
  afterFailure,
  DELETION_MAX_ATTEMPTS,
  DeletionWorker,
} from './deletion-worker.service';
import { ProfileEraser } from './profile-eraser';

const USER = '11111111-1111-4111-8111-111111111111';
const JOB = '0123456789abcdef0123456789abcdef';

describe('afterFailure() (spec 1.6 §1.3.5 steps 4–5)', () => {
  const retryable = { result: 'retryable_failure', code: 'x' } as const;
  const permanent = { result: 'permanent_failure', code: 'x' } as const;

  it('queues a retryable failure again while attempts are left', () => {
    for (let attempts = 1; attempts < DELETION_MAX_ATTEMPTS; attempts++) {
      expect(afterFailure(retryable, attempts)).toBe('queued');
    }
  });

  it('fails the job at the 5th start', () => {
    expect(afterFailure(retryable, DELETION_MAX_ATTEMPTS)).toBe('failed');
  });

  it('fails a permanent failure at once', () => {
    expect(afterFailure(permanent, 1)).toBe('failed');
  });
});

function worker(
  options: {
    claims?: { id: string; user_id: string; attempts: number }[];
    erase?: EraseResult;
    user?: { status: string; photo_key: string | null };
    job?: { status: string; attempts: number; tombstone_email: string };
    failTransaction?: boolean;
    failUpdated?: number;
    removedRoles?: number;
  } = {},
) {
  const claims = [...(options.claims ?? [])];
  const sql = jest.fn((text: string): Promise<unknown> => {
    if (text.includes("SET status = 'failed'") && text.includes('attempts >='))
      return Promise.resolve([[], 0]);
    if (text.includes("SET status = 'running'")) {
      const next = claims.shift();
      return Promise.resolve([next ? [next] : [], next ? 1 : 0]);
    }
    if (text.startsWith('SELECT status, photo_key FROM users'))
      return Promise.resolve(
        options.user
          ? [options.user]
          : [{ status: 'deleting', photo_key: null }],
      );
    if (text.startsWith('SELECT status, attempts, tombstone_email'))
      return Promise.resolve([
        options.job ?? {
          status: 'running',
          attempts: 1,
          tombstone_email: 'deleted.x@example.invalid',
        },
      ]);
    if (text.startsWith('DELETE FROM user_roles'))
      return Promise.resolve([[], options.removedRoles ?? 0]);
    if (text.includes('$2::deletion_job_status'))
      return Promise.resolve([[], options.failUpdated ?? 1]);
    return Promise.resolve([[], 0]);
  });
  const transaction = jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
    options.failTransaction
      ? Promise.reject(new Error('connection lost'))
      : work({ query: sql } as unknown as EntityManager),
  );
  const eraseAll = jest
    .fn()
    .mockResolvedValue(options.erase ?? { result: 'succeeded' });
  const config = {
    get: (key: string) =>
      key === 'NODE_ENV'
        ? 'test'
        : key === 'DELETION_WORKER_LEASE_SECONDS'
          ? 300
          : undefined,
  } as unknown as ConfigService;
  const instance = new DeletionWorker(
    { query: sql, transaction } as unknown as DataSource,
    config,
    { eraseAll } as unknown as UserDataErasers,
  );
  return { instance, sql, eraseAll, transaction };
}
const ran = (sql: jest.Mock, fragment: string) =>
  sql.mock.calls.some(([text]: [string]) => text.includes(fragment));
const failureCall = (sql: jest.Mock) =>
  sql.mock.calls.find(([text]: [string]) =>
    text.includes('$2::deletion_job_status'),
  ) as [string, unknown[]] | undefined;
const claim = { id: JOB, user_id: USER, attempts: 1 };

describe('DeletionWorker (spec 1.6 §1.3.5, §1.3.6)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing without a due job, and does not start in tests', async () => {
    const { instance, eraseAll } = worker();
    instance.onModuleInit();
    expect(await instance.run()).toBe(0);
    expect(eraseAll).not.toHaveBeenCalled();
    instance.onModuleDestroy();
  });

  it('erases with the user and job ids, then anonymizes in policy → user → job order', async () => {
    const { instance, sql, eraseAll } = worker({ claims: [claim] });
    expect(await instance.run()).toBe(1);
    expect(eraseAll).toHaveBeenCalledWith(USER, JOB);
    const order = [
      'FROM rbac_policy_state',
      'SELECT status, photo_key FROM users',
      'SELECT status, attempts, tombstone_email',
    ].map((fragment) =>
      sql.mock.calls.findIndex(([text]: [string]) => text.includes(fragment)),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ran(sql, "status = 'deleted'")).toBe(true);
    expect(ran(sql, "SET status = 'succeeded'")).toBe(true);
    // No roles were left, so the RBAC version is not bumped.
    expect(ran(sql, 'version = version + 1')).toBe(false);
  });

  it('bumps the RBAC version only when roles were actually removed', async () => {
    const { instance, sql } = worker({ claims: [claim], removedRoles: 1 });
    await instance.run();
    expect(ran(sql, 'version = version + 1')).toBe(true);
  });

  it('a retryable eraser failure requeues with the safe code; a permanent one fails', async () => {
    const retry = worker({
      claims: [claim],
      erase: { result: 'retryable_failure', code: 'storage_unavailable' },
    });
    await retry.instance.run();
    expect(failureCall(retry.sql)?.[1]).toEqual([
      JOB,
      'queued',
      'storage_unavailable',
      1,
      60,
    ]);
    const permanent = worker({
      claims: [claim],
      erase: { result: 'permanent_failure', code: 'refused' },
    });
    await permanent.instance.run();
    expect(failureCall(permanent.sql)?.[1][1]).toBe('failed');
  });

  it('a final transaction that does not commit is retryable', async () => {
    const { instance, sql } = worker({
      claims: [claim],
      failTransaction: true,
    });
    await instance.run();
    expect(failureCall(sql)?.[1].slice(1, 3)).toEqual([
      'queued',
      'finalize_failed',
    ]);
  });

  it('a photo still referenced is retryable', async () => {
    const { instance, sql } = worker({
      claims: [claim],
      user: { status: 'deleting', photo_key: 'k.webp' },
    });
    await instance.run();
    expect(failureCall(sql)?.[1][2]).toBe('photo_remaining');
    expect(ran(sql, "status = 'deleted'")).toBe(false);
  });

  it('an already finished job is an idempotent success; a job owned by a newer run is left alone', async () => {
    const done = worker({
      claims: [claim],
      user: { status: 'deleted', photo_key: null },
      job: { status: 'succeeded', attempts: 1, tombstone_email: 't' },
    });
    await done.instance.run();
    expect(ran(done.sql, "status = 'deleted'")).toBe(false);
    expect(failureCall(done.sql)).toBeUndefined();

    const lost = worker({
      claims: [claim],
      job: { status: 'running', attempts: 2, tombstone_email: 't' },
    });
    await lost.instance.run();
    expect(ran(lost.sql, "status = 'deleted'")).toBe(false);
    expect(failureCall(lost.sql)).toBeUndefined();
  });

  it('a failure update fenced out by a newer claim changes nothing', async () => {
    const { instance, sql } = worker({
      claims: [claim],
      erase: { result: 'retryable_failure', code: 'x' },
      failUpdated: 0,
    });
    await instance.run();
    expect(failureCall(sql)).toBeDefined();
  });

  it('processes at most `limit` jobs per run and never overlaps itself', async () => {
    const { instance, eraseAll } = worker({ claims: [claim, claim, claim] });
    const [first, second] = await Promise.all([
      instance.run(2),
      instance.run(2),
    ]);
    expect(first + second).toBe(2);
    expect(eraseAll).toHaveBeenCalledTimes(2);
  });
});

describe('ProfileEraser (spec 1.6 §1.3.5)', () => {
  function eraser(
    row: { status: string; photo_key: string | null } | undefined,
    deleted: 'deleted' | 'not_found' | 'unavailable' = 'deleted',
  ) {
    const sql = jest.fn((text: string) =>
      Promise.resolve(text.startsWith('SELECT') ? (row ? [row] : []) : []),
    );
    const storage = { delete: jest.fn().mockResolvedValue(deleted) };
    const register = jest.fn();
    const instance = new ProfileEraser(
      { query: sql } as unknown as DataSource,
      storage as unknown as ObjectStorage,
      { register } as unknown as UserDataErasers,
    );
    instance.onModuleInit();
    expect(register).toHaveBeenCalledWith(instance);
    return { instance, sql, storage };
  }

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('succeeds without a photo or a user, touching nothing', async () => {
    for (const row of [undefined, { status: 'deleting', photo_key: null }]) {
      const { instance, storage } = eraser(row);
      expect(await instance.eraseUserData(USER)).toEqual({
        result: 'succeeded',
      });
      expect(storage.delete).not.toHaveBeenCalled();
    }
  });

  it('deletes the object (a missing one too) and drops the reference', async () => {
    for (const result of ['deleted', 'not_found'] as const) {
      const { instance, sql, storage } = eraser(
        { status: 'deleting', photo_key: 'k.webp' },
        result,
      );
      expect(await instance.eraseUserData(USER)).toEqual({
        result: 'succeeded',
      });
      expect(storage.delete).toHaveBeenCalledWith('k.webp');
      expect(ran(sql, 'SET photo_key = NULL')).toBe(true);
    }
  });

  it('retries when storage is unavailable, and refuses a user that is not being deleted', async () => {
    const down = eraser(
      { status: 'deleting', photo_key: 'k.webp' },
      'unavailable',
    );
    expect(await down.instance.eraseUserData(USER)).toEqual({
      result: 'retryable_failure',
      code: 'storage_unavailable',
    });
    expect(ran(down.sql, 'SET photo_key = NULL')).toBe(false);
    const active = eraser({ status: 'active', photo_key: 'k.webp' });
    expect(await active.instance.eraseUserData(USER)).toEqual({
      result: 'permanent_failure',
      code: 'user_not_deleting',
    });
    expect(active.storage.delete).not.toHaveBeenCalled();
  });
});
