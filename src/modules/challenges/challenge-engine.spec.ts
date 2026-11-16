import { Logger } from '@nestjs/common';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import {
  MailUnavailableError,
  type MailService,
} from '@/core/mail/mail.service';

import {
  ChallengeEngine,
  type IssuedChallenge,
} from './challenge-engine.service';
import { CHALLENGE_SCENARIOS } from './challenge-scenarios';

const ID = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
const config = {
  get: () => Buffer.alloc(32, 1).toString('base64url'),
} as unknown as ConfigService;

const issued = (overrides: Partial<IssuedChallenge> = {}): IssuedChallenge => ({
  scenario: 'login',
  id: ID,
  method: 'otp',
  secret: '048213',
  ...overrides,
});

describe('CHALLENGE_SCENARIOS', () => {
  it('maps each scenario to its own table, key and id field', () => {
    expect(CHALLENGE_SCENARIOS).toEqual({
      registration: expect.objectContaining({
        table: 'registration_challenges',
        hmacKey: 'REGISTRATION_CHALLENGE_HMAC_KEY',
        idField: 'attemptId',
        tokenCarriesId: false,
      }) as unknown,
      login: expect.objectContaining({
        table: 'login_challenges',
        hmacKey: 'LOGIN_CHALLENGE_HMAC_KEY',
        idField: 'attemptId',
        tokenCarriesId: true,
      }) as unknown,
      email_change: expect.objectContaining({
        table: 'email_change_challenges',
        hmacKey: 'EMAIL_CHANGE_HMAC_KEY',
        idField: 'challengeId',
        tokenCarriesId: true,
      }) as unknown,
      deletion: expect.objectContaining({
        table: 'deletion_challenges',
        hmacKey: 'DELETION_CHALLENGE_HMAC_KEY',
        idField: 'challengeId',
        tokenCarriesId: true,
      }) as unknown,
    });
  });
});

describe('ChallengeEngine', () => {
  const sendChallenge = jest.fn<Promise<void>, unknown[]>();
  const engine = new ChallengeEngine(config, {
    sendChallenge,
  } as unknown as MailService);

  beforeEach(() => {
    sendChallenge.mockReset().mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('accepted()', () => {
    it('is the 202 body: method, the id under its scenario name, TTL and cooldown, never the secret', () => {
      expect(engine.accepted(issued())).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId: ID,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(
        engine.accepted(
          issued({ scenario: 'email_change', method: 'magic_link' }),
        ),
      ).toEqual({
        confirmationRequired: true,
        method: 'magic_link',
        challengeId: ID,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
    });
  });

  describe('deliver()', () => {
    it('mails the code for an OTP and the token for a magic link', async () => {
      await engine.deliver('a@example.com', issued());
      await engine.deliver(
        'b@example.com',
        issued({
          scenario: 'deletion',
          method: 'magic_link',
          secret: `${ID}.s3cret`,
        }),
      );

      expect(sendChallenge.mock.calls).toEqual([
        ['a@example.com', { scenario: 'login', method: 'otp', code: '048213' }],
        [
          'b@example.com',
          { scenario: 'deletion', method: 'magic_link', token: `${ID}.s3cret` },
        ],
      ]);
    });

    it('turns a mail failure into the 503 the specs describe: the challenge is kept, no secret', async () => {
      sendChallenge.mockRejectedValue(new MailUnavailableError('ECONNECTION'));

      const delivery = engine.deliver(
        'a@example.com',
        issued({ scenario: 'deletion' }),
      );

      await expect(delivery).rejects.toBeInstanceOf(AppException);
      await expect(delivery).rejects.toMatchObject({
        code: 'service_unavailable',
        extras: {
          confirmationRequired: true,
          method: 'otp',
          challengeId: ID,
          retryAfterSeconds: 60,
        },
      });
    });

    it('lets any other error through unchanged', async () => {
      const boom = new TypeError('bug');
      sendChallenge.mockRejectedValue(boom);

      await expect(engine.deliver('a@example.com', issued())).rejects.toBe(
        boom,
      );
    });
  });
});
