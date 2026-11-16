import { Logger } from '@nestjs/common';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { ReadinessRegistry } from '@/core/health/readiness.registry';

import {
  MAIL_TIMEOUT_MS,
  MailService,
  type MailTransport,
  MailUnavailableError,
} from './mail.service';

const TO = 'recipient-7c2a@example.com';
const config = {
  get: (key: string) =>
    ({
      MAIL_FROM: 'Backend Course <no-reply@example.test>',
      FRONTEND_URL: 'https://app.example.test',
    })[key],
} as unknown as ConfigService;

function serviceWith(transport: Record<string, unknown>) {
  const registry = new ReadinessRegistry();
  const service = new MailService(
    transport as unknown as MailTransport,
    config,
    registry,
  );
  return { service, registry };
}

describe('MailService', () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const logged = () =>
    JSON.stringify([info.mock.calls as unknown, warn.mock.calls as unknown]);

  it('sends a challenge mail from MAIL_FROM and logs the template, never the recipient or secret', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const { service } = serviceWith({ sendMail });

    await service.sendChallenge(TO, {
      scenario: 'login',
      method: 'otp',
      code: '481516',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Backend Course <no-reply@example.test>',
        to: TO,
        subject: expect.any(String) as string,
        text: expect.stringContaining('481516') as string,
        html: expect.stringContaining('481516') as string,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      { template: 'login_otp', durationMs: expect.any(Number) as number },
      'mail sent',
    );
    expect(logged()).not.toContain('recipient-7c2a');
    expect(logged()).not.toContain('481516');
  });

  it('turns a transport error into 503 service_unavailable, logging only its code', async () => {
    const error = Object.assign(
      new Error(`Recipient command failed: 550 <${TO}>`),
      {
        code: 'EENVELOPE',
        response: `550 5.1.1 <${TO}> unknown`,
      },
    );
    const { service } = serviceWith({
      sendMail: jest.fn().mockRejectedValue(error),
    });

    const sent = service.sendChallenge(TO, {
      scenario: 'login',
      method: 'otp',
      code: '1',
    });

    await expect(sent).rejects.toBeInstanceOf(MailUnavailableError);
    await expect(sent).rejects.toBeInstanceOf(AppException);
    await expect(sent).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'EENVELOPE',
    });
    expect(warn).toHaveBeenCalledWith(
      {
        template: 'login_otp',
        reason: 'EENVELOPE',
        durationMs: expect.any(Number) as number,
      },
      'mail delivery failed',
    );
    expect(logged()).not.toContain('recipient-7c2a');
  });

  it('reports an error without a code as reason "error"', async () => {
    const { service } = serviceWith({
      sendMail: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      service.sendChallenge(TO, {
        scenario: 'login',
        method: 'otp',
        code: '1',
      }),
    ).rejects.toMatchObject({ reason: 'error' });
  });

  it(`gives up after ${MAIL_TIMEOUT_MS} ms if the server never answers`, async () => {
    jest.useFakeTimers();
    const { service } = serviceWith({
      sendMail: jest.fn(() => new Promise(() => {})),
    });

    const sent = service.sendChallenge(TO, {
      scenario: 'login',
      method: 'otp',
      code: '1',
    });
    const outcome = expect(sent).rejects.toMatchObject({ reason: 'timeout' });
    await jest.advanceTimersByTimeAsync(MAIL_TIMEOUT_MS);

    await outcome;
  });

  it('registers an smtp readiness check backed by verify()', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const { service, registry } = serviceWith({ verify });
    service.onModuleInit();

    expect(registry.names()).toContain('smtp');
    expect(await service.check()).toBe('up');

    verify.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ESOCKET' }),
    );
    expect(await service.check()).toEqual({ down: 'ESOCKET' });
  });
});
