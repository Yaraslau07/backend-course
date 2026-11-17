import { DataSource, type EntityManager } from 'typeorm';
import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { Ownership } from '@/core/authorization/ownership';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';
import {
  ChallengeEngine,
  ChallengeRejected,
} from '@/modules/challenges/challenge-engine.service';
import { ObjectStorage } from '@/modules/storage/object-storage';
import { UsersUpdateService } from './users-update.service';
import { PhotoNormalizer } from './photo-normalizer';
import type { ProfileRow } from './safe-profile';

const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const row: ProfileRow = {
  id: actor,
  email: 'old@example.com',
  display_name: null,
  photo_key: null,
  status: 'active',
  created_at: new Date(0),
  updated_at: new Date(0),
};
const issued = {
  id: challengeId,
  method: 'otp',
  scenario: 'email_change',
  secret: '123456',
};
function setup() {
  const state = {
    row: { ...row } as ProfileRow | undefined,
    updated: { ...row },
    occupied: false,
    holder: true,
    referenced: false,
  };
  const sql = jest.fn((text: string): Promise<unknown> => {
    if (text.startsWith('SELECT id, email'))
      return Promise.resolve(state.row ? [state.row] : []);
    if (text.trimStart().startsWith('SELECT EXISTS'))
      return Promise.resolve([{ ok: state.holder }]);
    if (text.startsWith('SELECT id FROM users WHERE email'))
      return Promise.resolve(state.occupied ? [{ id: other }] : []);
    if (text.startsWith('SELECT id FROM users WHERE photo_key'))
      return Promise.resolve(state.referenced ? [{ id: actor }] : []);
    if (text.startsWith('SELECT new_email'))
      return Promise.resolve([{ new_email: 'new@example.com' }]);
    if (text.startsWith('UPDATE users') && text.includes('RETURNING'))
      return Promise.resolve([[state.updated], 1]);
    if (text.startsWith('INSERT INTO storage_cleanup_jobs'))
      return Promise.resolve([{ id: 'job-id' }]);
    return Promise.resolve([]);
  });
  const transaction = jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
    work({ query: sql } as unknown as EntityManager),
  );
  const ownership = {
    selfOr: jest.fn().mockResolvedValue('self'),
    assertOwner: jest.fn(),
  };
  const authorizer = { authorize: jest.fn().mockResolvedValue(undefined) };
  const challenges = {
    issue: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    resend: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    confirm: jest.fn().mockResolvedValue({
      ok: true,
      value: { id: challengeId, newEmail: 'new@example.com' },
    }),
    claim: jest.fn().mockResolvedValue(true),
    consumeOutstanding: jest.fn().mockResolvedValue(1),
    deliver: jest.fn().mockResolvedValue(undefined),
    accepted: jest
      .fn()
      .mockReturnValue({ confirmationRequired: true, challengeId }),
  };
  const limiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
  const storage = {
    write: jest.fn().mockResolvedValue('stored'),
    delete: jest.fn().mockResolvedValue('deleted'),
  };
  const photos = {
    normalize: jest.fn().mockResolvedValue(Buffer.from('normalized')),
  };
  const service = new UsersUpdateService(
    { query: sql, transaction } as unknown as DataSource,
    {
      get: (key: string) =>
        key === 'EMAIL_CHANGE_METHOD' ? 'otp' : 'https://api.example.com',
    } as ConfigService,
    ownership as unknown as Ownership,
    authorizer as unknown as RbacAuthorizer,
    challenges as unknown as ChallengeEngine,
    limiter as unknown as RateLimiter,
    storage as unknown as ObjectStorage,
    photos as unknown as PhotoNormalizer,
  );
  return {
    service,
    state,
    sql,
    transaction,
    ownership,
    authorizer,
    challenges,
    limiter,
    storage,
    photos,
  };
}
const confirm = (s: ReturnType<typeof setup>) =>
  s.service.confirmEmail(actor, actor, { challengeId, code: '123456' });
const file = () =>
  Promise.resolve({ bytes: Buffer.from('encoded'), mime: 'image/png' });
const unique = () =>
  Object.assign(new Error('private database detail'), {
    name: 'QueryFailedError',
    driverError: { code: '23505', constraint: 'uq_users_email' },
  });

describe('transactional profile changes', () => {
  it('returns no-ops without writes and checks admin fields before lookup', async () => {
    const s = setup();
    await s.service.patch(actor, actor, {
      displayName: null,
      email: row.email,
      status: 'active',
    });
    expect(s.authorizer.authorize).toHaveBeenCalled();
    expect(
      s.sql.mock.calls.some(([sql]) => sql.startsWith('UPDATE users')),
    ).toBe(false);
    s.authorizer.authorize.mockRejectedValue(
      new AppException('permission_denied'),
    );
    s.sql.mockClear();
    await expect(
      s.service.patch(actor, actor, { email: 'new@example.com' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(s.sql).not.toHaveBeenCalled();
  });
  it('locks policy before user, checks the last holder, and consumes challenges on a block', async () => {
    const s = setup();
    await s.service.patch(actor, other, {
      displayName: 'Name',
      email: 'new@example.com',
      status: 'blocked',
    });
    expect(s.sql.mock.calls[0][0]).toContain('rbac_policy_state');
    expect(s.sql.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(s.challenges.consumeOutstanding).toHaveBeenCalledWith(
      expect.anything(),
      'email_change',
      actor,
      'admin_override',
    );
    expect(s.challenges.consumeOutstanding).toHaveBeenCalledWith(
      expect.anything(),
      'login',
      actor,
      'user_inactive',
    );
    expect(s.challenges.consumeOutstanding).toHaveBeenCalledWith(
      expect.anything(),
      'email_change',
      actor,
      'user_inactive',
    );
    expect(s.sql).toHaveBeenCalledWith(
      expect.stringContaining('version = version + 1'),
    );
  });
  it('refuses removing the last manager and preserves unexpected failures', async () => {
    const s = setup();
    s.state.holder = false;
    await expect(
      s.service.patch(actor, actor, { status: 'blocked' }),
    ).rejects.toMatchObject({ code: 'last_rbac_manager' });
    const down = setup();
    down.sql.mockRejectedValueOnce(new Error('database down'));
    await expect(
      down.service.patch(actor, actor, { displayName: 'Name' }),
    ).rejects.toThrow('database down');
  });
  it.each(['pending', 'deleting', 'deleted'] as const)(
    'refuses %s without updates',
    async (status) => {
      const s = setup();
      s.state.row!.status = status;
      await expect(
        s.service.patch(actor, actor, { displayName: 'Name' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    },
  );
  it('returns 404 for absent targets and maps unique email conflicts', async () => {
    const s = setup();
    s.state.row = undefined;
    await expect(
      s.service.patch(actor, 'absent', { displayName: 'Name' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const collision = setup();
    collision.transaction.mockRejectedValueOnce(unique());
    await expect(
      collision.service.patch(actor, actor, { email: 'new@example.com' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });
});

describe('email challenge transactions', () => {
  it('issues and resends after committing, consumes quota on the same manager', async () => {
    const s = setup();
    expect(
      await s.service.startEmail(actor, actor, { newEmail: 'new@example.com' }),
    ).toEqual({ confirmationRequired: true, challengeId });
    expect(s.challenges.deliver.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.transaction.mock.invocationCallOrder[0],
    );
    expect(s.limiter.consume).toHaveBeenCalledWith(
      'email_change_emails',
      [actor],
      expect.objectContaining({ query: s.sql }),
    );
    await s.service.resendEmail(actor, actor, { challengeId });
    expect(s.challenges.deliver).toHaveBeenLastCalledWith(
      'new@example.com',
      issued,
    );
  });
  it('rejects occupied/current emails and enforces hourly quota', async () => {
    const s = setup();
    await expect(
      s.service.startEmail(actor, actor, { newEmail: row.email }),
    ).rejects.toMatchObject({ code: 'conflict' });
    s.state.occupied = true;
    await expect(
      s.service.startEmail(actor, actor, { newEmail: 'new@example.com' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    s.state.occupied = false;
    s.limiter.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 123,
    });
    await expect(
      s.service.startEmail(actor, actor, { newEmail: 'new@example.com' }),
    ).rejects.toMatchObject({
      code: 'too_many_requests',
      extras: { retryAfterSeconds: 123 },
    });
    expect(s.challenges.deliver).not.toHaveBeenCalled();
  });
  it('commits refusal outcomes, never mails them, and keeps committed challenges on SMTP failure', async () => {
    const s = setup();
    const error = new ChallengeRejected('resend_cooldown', 'cooldown');
    s.challenges.issue.mockResolvedValue({ ok: false, error });
    await expect(
      s.service.startEmail(actor, actor, { newEmail: 'new@example.com' }),
    ).rejects.toBe(error);
    s.challenges.resend.mockResolvedValue({ ok: false, error });
    await expect(
      s.service.resendEmail(actor, actor, { challengeId }),
    ).rejects.toBe(error);
    expect(s.challenges.deliver).not.toHaveBeenCalled();
    const smtp = setup();
    smtp.challenges.deliver.mockRejectedValue(
      new AppException('service_unavailable', { confirmationRequired: true }),
    );
    await expect(
      smtp.service.startEmail(actor, actor, { newEmail: 'new@example.com' }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(smtp.limiter.consume).toHaveBeenCalled();
  });
  it.each(['start', 'resend', 'confirm'])(
    'consumes the outstanding challenge if the user becomes inactive during %s',
    async (flow) => {
      const s = setup();
      s.state.row!.status = 'blocked';
      const result =
        flow === 'start'
          ? s.service.startEmail(actor, actor, { newEmail: 'new@example.com' })
          : flow === 'resend'
            ? s.service.resendEmail(actor, actor, { challengeId })
            : confirm(s);
      await expect(result).rejects.toMatchObject({ code: 'invalid_session' });
      expect(s.challenges.consumeOutstanding).toHaveBeenCalledWith(
        expect.anything(),
        'email_change',
        actor,
        'user_inactive',
      );
    },
  );
  it('claims before update, keeps wrong-attempt outcomes, and rolls unique conflicts back to the savepoint', async () => {
    const s = setup();
    await confirm(s);
    expect(s.challenges.claim).toHaveBeenCalledWith(
      expect.anything(),
      'email_change',
      challengeId,
      'confirmed',
    );
    const wrong = setup();
    wrong.challenges.confirm.mockResolvedValue({
      ok: false,
      error: new ChallengeRejected('invalid_challenge', 'wrong_secret'),
    });
    await expect(confirm(wrong)).rejects.toMatchObject({
      code: 'invalid_challenge',
    });
    expect(wrong.challenges.claim).not.toHaveBeenCalled();
    const collision = setup();
    const original = collision.sql.getMockImplementation()!;
    collision.sql.mockImplementation((text) =>
      text.startsWith('UPDATE users')
        ? Promise.reject(unique())
        : original(text),
    );
    await expect(confirm(collision)).rejects.toMatchObject({
      code: 'email_taken',
    });
    expect(collision.sql).toHaveBeenCalledWith(
      'ROLLBACK TO SAVEPOINT email_update',
    );
    expect(collision.challenges.claim).toHaveBeenLastCalledWith(
      expect.anything(),
      'email_change',
      challengeId,
      'email_conflict',
    );
  });
  it('rolls back on lost claims or unexpected update failure', async () => {
    const s = setup();
    s.challenges.claim.mockResolvedValue(false);
    await expect(confirm(s)).rejects.toMatchObject({
      code: 'invalid_challenge',
    });
    const down = setup();
    down.sql.mockRejectedValueOnce(new Error('database down'));
    await expect(confirm(down)).rejects.toThrow('database down');
  });
});

describe('photo atomicity', () => {
  it('writes normalized bytes then replaces a photo and queues the old key', async () => {
    const s = setup();
    s.state.row!.photo_key = 'old-key';
    await s.service.upload(actor, actor, file);
    expect(s.storage.write).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}\.webp$/),
      Buffer.from('normalized'),
    );
    expect(s.sql).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO storage_cleanup_jobs'),
      ['old-key', 'photo_replaced'],
    );
    expect(s.storage.delete).not.toHaveBeenCalled();
  });
  it('does not write a file for an absent/invalid target or invalid image', async () => {
    const s = setup();
    s.state.row = undefined;
    await expect(s.service.upload(actor, 'absent', file)).rejects.toMatchObject(
      { code: 'not_found' },
    );
    expect(s.storage.write).not.toHaveBeenCalled();
    const corrupt = setup();
    corrupt.photos.normalize.mockRejectedValue(new AppException('bad_request'));
    await expect(
      corrupt.service.upload(actor, actor, file),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(corrupt.transaction).not.toHaveBeenCalled();
  });
  it('does not update on storage failure and compensates after a row-status race', async () => {
    const s = setup();
    s.storage.write.mockResolvedValue('unavailable');
    await expect(s.service.upload(actor, actor, file)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(
      s.sql.mock.calls.some(([text]) => text.startsWith('UPDATE users')),
    ).toBe(false);
    const race = setup();
    race.storage.write.mockImplementation(() => {
      race.state.row!.status = 'deleting';
      return Promise.resolve('stored');
    });
    await expect(race.service.upload(actor, actor, file)).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect(race.storage.delete).toHaveBeenCalledTimes(1);
    expect(race.sql).toHaveBeenCalledWith(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [actor],
    );
  });
  it('keeps an adopted object after an uncertain commit and defers cleanup if DB is unreadable', async () => {
    for (const mode of ['referenced', 'unavailable']) {
      const s = setup();
      s.state.referenced = true;
      s.transaction.mockImplementation(async (work) => {
        await work({ query: s.sql } as unknown as EntityManager);
        if (mode === 'unavailable')
          s.sql.mockRejectedValueOnce(new Error('db unavailable'));
        throw new Error('commit acknowledgement lost');
      });
      await expect(s.service.upload(actor, actor, file)).rejects.toThrow(
        'commit acknowledgement lost',
      );
      expect(s.storage.delete).not.toHaveBeenCalled();
    }
  });
  it('clears a reference and queues deletion, but leaves no-op timestamps untouched', async () => {
    const s = setup();
    await s.service.clearPhoto(actor, actor);
    expect(
      s.sql.mock.calls.some(([text]) => text.startsWith('UPDATE users')),
    ).toBe(false);
    s.state.row!.photo_key = 'old-key';
    await s.service.clearPhoto(actor, actor);
    expect(s.sql).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO storage_cleanup_jobs'),
      ['old-key', 'photo_cleared'],
    );
    expect(s.storage.delete).not.toHaveBeenCalled();
  });
});
