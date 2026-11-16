import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import {
  type ChallengeEngine,
  ChallengeRejected,
} from '@/modules/challenges/challenge-engine.service';

import { RegistrationConfirmDto } from './dto/registration-confirm.dto';
import { RegistrationResendDto } from './dto/registration-resend.dto';
import type { PasswordHasher } from './password-hasher';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

/**
 * Registration's decisions with the database and engine scripted. The real flow, against Postgres
 * and Mailpit, is in test/registration.e2e-spec.ts.
 */
const USER = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const ATTEMPT = '9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d';
const issued = {
  scenario: 'registration' as const,
  id: ATTEMPT,
  method: 'otp' as const,
  secret: '123456',
};

function setup(
  options: {
    confirm?: boolean;
    user?: { id: string; email: string; status: string } | null;
    insertError?: unknown;
  } = {},
) {
  // The second parameter only types mock.calls[i][1] for the assertions below.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const query = jest.fn((sql: string, _params?: unknown[]) => {
    if (sql.startsWith('INSERT INTO users')) {
      return options.insertError
        ? Promise.reject(options.insertError as Error)
        : Promise.resolve([{ id: USER }]);
    }
    if (sql.startsWith('SELECT id, email, status')) {
      return Promise.resolve(
        options.user === null
          ? []
          : [
              options.user ?? {
                id: USER,
                email: 'a@example.com',
                status: 'pending',
              },
            ],
      );
    }
    return Promise.resolve([[], 1]);
  });
  const manager = { query } as unknown as EntityManager;
  const db = {
    manager,
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager),
  } as unknown as DataSource;
  const config = {
    get: (key: string) =>
      ({
        REGISTRATION_EMAIL_CONFIRMATION_ENABLED: options.confirm ?? false,
        REGISTRATION_EMAIL_CONFIRMATION_METHOD: 'otp',
      })[key],
  } as unknown as ConfigService;
  const hasher = {
    hash: jest.fn().mockResolvedValue('$argon2id$hash'),
  } as unknown as PasswordHasher;
  const engine = {
    issue: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    resend: jest.fn().mockResolvedValue({ ok: true, value: issued }),
    confirm: jest.fn().mockResolvedValue({ ok: true, value: { id: ATTEMPT } }),
    claim: jest.fn().mockResolvedValue(true),
    latest: jest.fn().mockResolvedValue(null),
    findUserId: jest.fn().mockResolvedValue(USER),
    deliver: jest.fn().mockResolvedValue(undefined),
    accepted: jest.fn().mockReturnValue({ confirmationRequired: true }),
  };
  const service = new RegistrationService(
    db,
    config,
    hasher,
    engine as unknown as ChallengeEngine,
  );
  return { service, engine, query };
}

const uniqueViolation = (constraint: string) =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('dup'), { code: '23505', constraint }),
  );

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return undefined;
}

describe('RegistrationService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  describe('register()', () => {
    const dto = { email: 'a@example.com', password: 'correct horse 1' };

    it('without confirmation: an active user, 201, no challenge or mail', async () => {
      const { service, engine, query } = setup();

      expect(await service.register(dto)).toEqual({
        status: 201,
        body: { id: USER, email: 'a@example.com', status: 'active' },
      });
      expect(query.mock.calls[0][1]).toEqual([
        'a@example.com',
        '$argon2id$hash',
        'active',
      ]);
      expect(engine.issue).not.toHaveBeenCalled();
      expect(engine.deliver).not.toHaveBeenCalled();
    });

    it('with confirmation: a pending user, a challenge, the mail after, 202', async () => {
      const { service, engine, query } = setup({ confirm: true });

      expect(await service.register(dto)).toEqual({
        status: 202,
        body: { confirmationRequired: true },
      });
      expect(query.mock.calls[0][1]).toEqual([
        'a@example.com',
        '$argon2id$hash',
        'pending',
      ]);
      expect(engine.issue).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        {
          userId: USER,
          method: 'otp',
        },
      );
      expect(engine.deliver).toHaveBeenCalledWith('a@example.com', issued);
    });

    it('turns the email unique violation into 409 email_taken', async () => {
      const { service } = setup({
        insertError: uniqueViolation('uq_users_email'),
      });

      expect(await codeOf(service.register(dto))).toBe('email_taken');
    });

    it('lets any other database error through', async () => {
      const other = uniqueViolation('uq_something_else');
      const { service } = setup({ insertError: other });

      await expect(service.register(dto)).rejects.toBe(other);
    });

    it('fails loudly if a brand-new user somehow has a cooldown', async () => {
      const { service, engine } = setup({ confirm: true });
      engine.issue.mockResolvedValue({
        ok: false,
        error: new ChallengeRejected('resend_cooldown', 'cooldown'),
      });

      expect(await codeOf(service.register(dto))).toBe('resend_cooldown');
    });
  });

  describe('confirm()', () => {
    it('claims the challenge, then activates the user', async () => {
      const { service, engine, query } = setup();

      expect(
        await service.confirm({ attemptId: ATTEMPT, code: '123456' }),
      ).toEqual({
        id: USER,
        email: 'a@example.com',
        status: 'active',
      });
      expect(engine.confirm).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        {
          challengeId: ATTEMPT,
          code: '123456',
          userId: USER,
          userEligible: true,
        },
      );
      const order = [
        engine.claim.mock.invocationCallOrder[0],
        query.mock.invocationCallOrder[
          query.mock.calls.findIndex(([sql]) =>
            String(sql).startsWith('UPDATE users'),
          )
        ],
      ];
      expect(order[0]).toBeLessThan(order[1]);
    });

    it('confirms a magic link by token', async () => {
      const { service, engine } = setup();

      await service.confirm({ token: 'secret-token' });

      expect(engine.confirm).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        {
          token: 'secret-token',
          userId: USER,
          userEligible: true,
        },
      );
    });

    it.each([
      ['both variants', { attemptId: ATTEMPT, code: '123456', token: 'x' }],
      ['an id without a code', { attemptId: ATTEMPT }],
      ['a code without an id', { code: '123456' }],
      ['nothing', {}],
    ])('refuses %s with validation_failed', async (_name, dto) => {
      const { service } = setup();

      expect(await codeOf(service.confirm(dto))).toBe('validation_failed');
    });

    it('answers an unknown challenge with invalid_challenge', async () => {
      const { service, engine } = setup();
      engine.findUserId.mockResolvedValue(null);

      expect(await codeOf(service.confirm({ token: 'x' }))).toBe(
        'invalid_challenge',
      );
    });

    it('answers a user that vanished meanwhile with invalid_challenge', async () => {
      const { service } = setup({ user: null });

      expect(await codeOf(service.confirm({ token: 'x' }))).toBe(
        'invalid_challenge',
      );
    });

    it('passes only a pending user as eligible', async () => {
      const { service, engine } = setup({
        user: { id: USER, email: 'a@example.com', status: 'active' },
      });
      engine.confirm.mockResolvedValue({
        ok: false,
        error: new ChallengeRejected('invalid_challenge', 'user_inactive'),
      });

      expect(await codeOf(service.confirm({ token: 'x' }))).toBe(
        'invalid_challenge',
      );
      expect(engine.confirm).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        expect.objectContaining({ userEligible: false }),
      );
    });

    it('does not activate when the claim is lost to a concurrent confirm', async () => {
      const { service, engine, query } = setup();
      engine.claim.mockResolvedValue(false);

      expect(await codeOf(service.confirm({ token: 'x' }))).toBe(
        'invalid_challenge',
      );
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).startsWith('UPDATE users'),
        ),
      ).toBe(false);
    });
  });

  describe('resend()', () => {
    it('resends the outstanding challenge', async () => {
      const { service, engine } = setup();
      engine.latest.mockResolvedValue({
        id: ATTEMPT,
        method: 'otp',
        outstanding: true,
        age: 70,
      });

      await service.resend({ email: 'a@example.com' });

      expect(engine.resend).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        {
          challengeId: ATTEMPT,
          userId: USER,
          userEligible: true,
        },
      );
      expect(engine.deliver).toHaveBeenCalledWith('a@example.com', issued);
    });

    it('issues a new challenge with the recorded method when the last one is used up', async () => {
      const { service, engine } = setup();
      engine.latest.mockResolvedValue({
        id: ATTEMPT,
        method: 'magic_link',
        outstanding: false,
        age: 70,
      });

      await service.resend({ email: 'a@example.com' });

      expect(engine.issue).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        {
          userId: USER,
          method: 'magic_link',
          cooldownFromLatest: true,
        },
      );
    });

    it('falls back to the configured method when there is no challenge at all', async () => {
      const { service, engine } = setup();

      await service.resend({ email: 'a@example.com' });

      expect(engine.issue).toHaveBeenCalledWith(
        expect.anything(),
        'registration',
        expect.objectContaining({ method: 'otp' }),
      );
    });

    it.each([
      ['an unknown email', null],
      [
        'an active user',
        { id: USER, email: 'a@example.com', status: 'active' },
      ],
    ])('answers %s with invalid_challenge', async (_name, user) => {
      const { service, engine } = setup({ user });

      expect(await codeOf(service.resend({ email: 'a@example.com' }))).toBe(
        'invalid_challenge',
      );
      expect(engine.deliver).not.toHaveBeenCalled();
    });

    it('passes a cooldown through', async () => {
      const { service, engine } = setup();
      engine.issue.mockResolvedValue({
        ok: false,
        error: new ChallengeRejected('resend_cooldown', 'cooldown', {
          retryAfterSeconds: 30,
        }),
      });

      expect(await codeOf(service.resend({ email: 'a@example.com' }))).toBe(
        'resend_cooldown',
      );
    });
  });
});

describe('RegistrationController', () => {
  it('answers with the status the service chose', async () => {
    const register = jest
      .fn()
      .mockResolvedValue({ status: 202, body: { confirmationRequired: true } });
    const controller = new RegistrationController({
      register,
      confirm: jest.fn().mockResolvedValue({ id: USER }),
      resend: jest.fn().mockResolvedValue({ method: 'otp' }),
    } as unknown as RegistrationService);
    const status = jest.fn();
    const reply = { status } as unknown as FastifyReply;

    expect(
      await controller.register(
        { email: 'a@example.com', password: 'x' },
        reply,
      ),
    ).toEqual({
      confirmationRequired: true,
    });
    expect(status).toHaveBeenCalledWith(202);
    expect(await controller.confirm({ token: 'x' })).toEqual({ id: USER });
    expect(await controller.resend({ email: 'a@example.com' })).toEqual({
      method: 'otp',
    });
  });
});

describe('confirm and resend DTOs', () => {
  const errors = (cls: new () => object, body: object) =>
    validateSync(plainToInstance(cls, body)).map((e) => e.property);

  it('validate the OTP variant, the token and the resend email', () => {
    expect(
      errors(RegistrationConfirmDto, { attemptId: ATTEMPT, code: '123456' }),
    ).toEqual([]);
    expect(
      errors(RegistrationConfirmDto, { attemptId: 'x', code: '12345' }),
    ).toEqual(['attemptId', 'code']);
    expect(errors(RegistrationConfirmDto, { token: 't'.repeat(201) })).toEqual([
      'token',
    ]);
    expect(errors(RegistrationResendDto, { email: ' A@Example.com ' })).toEqual(
      [],
    );
    expect(errors(RegistrationResendDto, { email: 'nope' })).toEqual(['email']);
  });
});
