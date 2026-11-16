import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppConfig } from '@/core/config/config.types';
import { MAIL_TIMEOUT_MS, MailService } from '@/core/mail/mail.service';
import { MAGIC_LINK_PATHS } from '@/core/mail/templates';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { hasMail, waitForMail } from './utils/mailpit';

const recipient = () => `mail-${randomUUID()}@example.com`;

describe('MailService (e2e, against Mailpit)', () => {
  const logs = new LogCapture();
  const sent: string[] = [];
  let app: NestFastifyApplication;
  let config: AppConfig;
  let mail: MailService;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({ logs }));
    mail = app.get(MailService);
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, sent);
    await app.close();
  });

  it('delivers an OTP mail that a test can read the code from', async () => {
    const to = recipient();
    sent.push(to, '602914');

    await mail.sendChallenge(to, {
      scenario: 'registration',
      method: 'otp',
      code: '602914',
    });

    const caught = await waitForMail(to);
    expect(caught.to).toEqual([to]);
    expect(caught.from).toBe(
      /<(.+)>/.exec(config.MAIL_FROM)?.[1] ?? config.MAIL_FROM,
    );
    expect(caught.text).toMatch(/\b602914\b/);
    expect(caught.subject).not.toContain('602914');
  });

  it('delivers a magic link with the token in the fragment of a FRONTEND_URL link', async () => {
    const to = recipient();
    const token = `attempt.${randomUUID()}`;
    sent.push(to, token);

    await mail.sendChallenge(to, {
      scenario: 'login',
      method: 'magic_link',
      token,
    });

    const caught = await waitForMail(to);
    const link = /https?:\/\/\S+/.exec(caught.text)?.[0] ?? '';
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${new URL(config.FRONTEND_URL).origin}${MAGIC_LINK_PATHS.login}`,
    );
    expect(url.search).toBe('');
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(token);
  });

  it('reports smtp as up in readiness', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect((res.body as { checks: Record<string, string> }).checks.smtp).toBe(
      'up',
    );
  });

  it('logs the send by template, without the recipient or the secret', () => {
    const lines = logs.lines().filter((line) => line.msg === 'mail sent');

    expect(lines.map((line) => line.template)).toEqual([
      'registration_otp',
      'login_magic_link',
    ]);
  });
});

describe('MailService when SMTP is unreachable (e2e)', () => {
  const originalPort = process.env.SMTP_PORT;
  let silent: Server;
  let silentPort: number;

  beforeAll(async () => {
    // Accepts the TCP connection and then says nothing, like a hung or firewalled server.
    silent = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      silent.listen(0, '127.0.0.1', resolve),
    );
    silentPort = (silent.address() as { port: number }).port;
  });

  afterAll(async () => {
    process.env.SMTP_PORT = originalPort;
    await new Promise((resolve) => silent.close(resolve));
  });

  async function appOnPort(port: number) {
    process.env.SMTP_PORT = String(port);
    return createTestApp();
  }

  it.each([
    ['refuses connections', () => 1],
    ['accepts and never answers', () => silentPort],
  ])(
    'fails with 503 service_unavailable within the timeout when the server %s, and nothing is sent',
    async (_case, port) => {
      const { app } = await appOnPort(port());
      try {
        const to = recipient();
        const started = Date.now();

        await expect(
          app
            .get(MailService)
            .sendChallenge(to, { scenario: 'login', method: 'otp', code: '1' }),
        ).rejects.toMatchObject({ code: 'service_unavailable' });

        expect(Date.now() - started).toBeLessThan(MAIL_TIMEOUT_MS + 500);
        expect(await hasMail(to)).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it('reports smtp as down in readiness', async () => {
    const { app } = await appOnPort(1);
    try {
      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect((res.body as { checks: Record<string, string> }).checks.smtp).toBe(
        'down',
      );
    } finally {
      await app.close();
    }
  });
});
