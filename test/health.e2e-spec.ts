import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

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
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);

    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /health/ready from loopback reports every built-in check up', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(res.body).toEqual({
      status: 'ok',
      checks: { database: 'up', config: 'up' },
    });
  });

  it('CORS preflight succeeds for an allowed origin with credentials and the CSRF header', async () => {
    const origin = config.CORS_ORIGINS[0];
    const res = await request(app.getHttpServer())
      .options('/health/live')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-protection')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(
      res.headers['access-control-allow-headers']?.toLowerCase(),
    ).toContain('x-csrf-protection');
  });

  it('CORS gives no allow-origin header to an unknown origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/health/live')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OpenAPI lists liveness and hides readiness', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    const paths = Object.keys((res.body as { paths: object }).paths);
    expect(paths).toContain('/health/live');
    expect(paths).not.toContain('/health/ready');
  });
});
