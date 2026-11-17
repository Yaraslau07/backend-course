import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppConfig } from '@/core/config/config.types';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { calls, RouteProbeModule } from './utils/route-probe.module';

/**
 * Specs 1.2 §1.3.3 and 1.3 §1.3.5: a state-changing request from another origin needs the exact
 * allowed Origin and `X-CSRF-Protection: 1`, regardless of whether the origins are same-site.
 * A rejection is 403 csrf_rejected and the handler does not run. Reads are never checked.
 */
describe('CSRF (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;
  let frontend: string;
  let selfOrigin: string;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      imports: [RouteProbeModule],
      logs,
    }));
    frontend = config.CORS_ORIGINS[0];
    selfOrigin = new URL(config.PUBLIC_API_BASE_URL).origin;
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, ['https://evil.example.com']);
    await app.close();
  });

  async function write(headers: Record<string, string>) {
    const before = calls['public-write'] ?? 0;
    const res = await app.inject({
      method: 'POST',
      url: '/__routes/public',
      headers,
    });
    return {
      status: res.statusCode,
      code: res.json<{ code?: unknown }>().code,
      ran: (calls['public-write'] ?? 0) > before,
      allowOrigin: res.headers['access-control-allow-origin'],
    };
  }

  it('accepts a write from an allowed origin with X-CSRF-Protection: 1', async () => {
    expect(
      await write({ Origin: frontend, 'X-CSRF-Protection': '1' }),
    ).toMatchObject({
      status: 201,
      ran: true,
    });
  });

  it('rejects a write from an allowed origin without the header, and the frontend can read why', async () => {
    expect(await write({ Origin: frontend })).toEqual({
      status: 403,
      code: 'csrf_rejected',
      ran: false,
      // CORS headers are still sent, so the frontend sees the 403 instead of a network error.
      allowOrigin: frontend,
    });
  });

  it('rejects a write from an unknown origin even with the header', async () => {
    expect(
      await write({
        Origin: 'https://evil.example.com',
        'X-CSRF-Protection': '1',
      }),
    ).toMatchObject({ status: 403, code: 'csrf_rejected', ran: false });
  });

  it('rejects an opaque origin', async () => {
    expect(
      await write({ Origin: 'null', 'X-CSRF-Protection': '1' }),
    ).toMatchObject({
      status: 403,
      code: 'csrf_rejected',
      ran: false,
    });
  });

  it('accepts a same-origin write without the header', async () => {
    expect(await write({ Origin: selfOrigin })).toMatchObject({
      status: 201,
      ran: true,
    });
  });

  it('accepts a write without Origin from a non-browser client', async () => {
    expect(await write({})).toMatchObject({ status: 201, ran: true });
  });

  it('rejects a write without Origin that the browser marks as cross-site', async () => {
    expect(await write({ 'Sec-Fetch-Site': 'cross-site' })).toMatchObject({
      status: 403,
      code: 'csrf_rejected',
      ran: false,
    });
  });

  it('never checks a read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__routes/public',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('logs each rejection with its reason and without the origin', () => {
    const rejected = logs
      .lines()
      .filter((line) => line.msg === 'cross-origin write rejected');

    expect(rejected.map((line) => line.reason)).toEqual([
      'header_missing',
      'origin_not_allowed',
      'origin_not_allowed',
      'origin_missing',
    ]);
    expect(rejected[0]).toMatchObject({
      level: 40,
      category: 'csrf_rejected',
      handler: 'RouteProbeController.publicWrite',
    });
  });
});
