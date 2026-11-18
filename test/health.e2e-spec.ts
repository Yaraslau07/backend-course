import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppConfig } from '@/core/config/config.types';

import { createTestApp } from './utils/create-test-app';

describe('Health and bootstrap (e2e)', () => {
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live is public and returns ok with security headers and a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /health/ready from loopback reports every built-in check up', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: {
        database: 'up',
        config: 'up',
        route_declarations: 'up',
        rbac: 'up',
        smtp: 'up',
        transformation_temp: 'up',
        transformations: 'up',
        user_data_erasers: 'up',
      },
    });
  });

  it('CORS preflight succeeds for an allowed origin with credentials and the CSRF header', async () => {
    const origin = config.CORS_ORIGINS[0];
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-protection',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(
      res.headers['access-control-allow-headers']?.toString().toLowerCase(),
    ).toContain('x-csrf-protection');
  });

  it('CORS gives no allow-origin header to an unknown origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OpenAPI lists liveness and hides readiness', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs-json' });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json<{ paths: object }>().paths);
    expect(paths).toContain('/health/live');
    expect(paths).not.toContain('/health/ready');
  });
});
