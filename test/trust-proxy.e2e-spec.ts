import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createTestApp } from './utils/create-test-app';
import { resetRateLimits } from './utils/rate-limits';
import { RouteProbeModule } from './utils/route-probe.module';

/**
 * Behind a reverse proxy (TRUST_PROXY=true), the client IP comes from X-Forwarded-For, so IP limits
 * count real clients rather than the proxy. Without it (the other suites), the header is ignored.
 */
describe('Rate limits behind a trusted proxy (e2e)', () => {
  let app: NestFastifyApplication;
  const original = process.env.TRUST_PROXY;

  beforeAll(async () => {
    process.env.TRUST_PROXY = 'true';
    ({ app } = await createTestApp({ imports: [RouteProbeModule] }));
    await resetRateLimits(app);
  });

  afterAll(async () => {
    process.env.TRUST_PROXY = original;
    await app.close();
  });

  const post = (forwardedFor: string) =>
    app.inject({
      method: 'POST',
      url: '/__routes/limited',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': forwardedFor },
    });

  it('counts each forwarded client separately, though all arrive from the same proxy', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await post('198.51.100.1')).statusCode).toBe(201);
    }

    expect((await post('198.51.100.1')).statusCode).toBe(429);
    expect((await post('198.51.100.2')).statusCode).toBe(201);
  });
});
