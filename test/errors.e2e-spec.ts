import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppConfig } from '@/core/config/config.types';
import { ERROR_CATALOGUE } from '@/core/errors/error-catalogue';

import { createTestApp } from './utils/create-test-app';
import { ErrorProbeModule, PROBE_SECRET } from './utils/error-probe.module';
import { LogCapture } from './utils/log-capture';

/**
 * The error envelope (docs/invariants.md, "Error codes catalogue"): every error, whatever threw it,
 * leaves as `{ statusCode, code, message, requestId }` plus safe extras, and neither the body nor
 * the logs repeat what the client sent or what a library said.
 */
describe('Error envelope (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      imports: [ErrorProbeModule],
      logs,
    }));
  });

  afterAll(async () => {
    logs.expectNoLeaks(config, [PROBE_SECRET]);
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const requestIdOf = (res: request.Response) =>
    (res.body as { requestId?: unknown }).requestId;

  /** The base envelope; `requestId` must match the X-Request-Id header. */
  function expectEnvelope(
    res: request.Response,
    status: number,
    code: keyof typeof ERROR_CATALOGUE,
    extras: Record<string, unknown> = {},
  ): void {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      statusCode: status,
      code,
      message: ERROR_CATALOGUE[code].message,
      requestId: res.headers['x-request-id'],
      ...extras,
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  }

  it('renders an AppException with its safe extras and Retry-After', async () => {
    const res = await http().get('/__probe/app-exception');

    expectEnvelope(res, 429, 'too_many_requests', {
      retryAfterSeconds: 17,
      attemptId: 'attempt-1',
    });
    expect(res.headers['retry-after']).toBe('17');
  });

  it('reuses a valid incoming X-Request-Id as requestId', async () => {
    const id = '9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d';

    const res = await http()
      .get('/__probe/app-exception')
      .set('X-Request-Id', id);

    expect(requestIdOf(res)).toBe(id);
  });

  describe('request validation', () => {
    const valid = {
      email: 'probe@schema-spec.invalid',
      password: 'long-enough-1',
      count: 2,
      address: { city: 'Minsk' },
    };

    it('passes a valid body through', async () => {
      await http()
        .post('/__probe/validate')
        .send(valid)
        .expect(200, { ok: true, count: 2 });
    });

    it('names the failing fields and rules, never the submitted values', async () => {
      const res = await http()
        .post('/__probe/validate')
        .send({
          ...valid,
          email: PROBE_SECRET,
          password: 'short',
          address: { city: 7 },
        });

      expectEnvelope(res, 400, 'validation_failed', {
        errors: [
          { field: 'email', rules: ['isEmail'] },
          { field: 'password', rules: ['minLength'] },
          { field: 'address.city', rules: ['isString'] },
        ],
      });
      expect(res.text).not.toContain(PROBE_SECRET);
    });

    it('rejects unknown fields', async () => {
      const res = await http()
        .post('/__probe/validate')
        .send({ ...valid, isAdmin: true });

      expectEnvelope(res, 400, 'validation_failed', {
        errors: [{ field: 'isAdmin', rules: ['whitelistValidation'] }],
      });
    });
  });

  describe('body parsing (rejected by Fastify before Nest sees the request)', () => {
    it('answers malformed JSON with invalid_json and no part of the body', async () => {
      const res = await http()
        .post('/__probe/validate')
        .set('Content-Type', 'application/json')
        .send(`{"email": "${PROBE_SECRET}", `);

      expectEnvelope(res, 400, 'invalid_json');
      expect(res.text).not.toContain(PROBE_SECRET);
    });

    it('answers an empty JSON body with invalid_json', async () => {
      const res = await http()
        .post('/__probe/validate')
        .set('Content-Type', 'application/json')
        .send('');

      expectEnvelope(res, 400, 'invalid_json');
    });

    it('refuses prototype pollution keys as invalid JSON', async () => {
      const res = await http()
        .post('/__probe/validate')
        .set('Content-Type', 'application/json')
        .send('{"__proto__": {"isAdmin": true}}');

      expectEnvelope(res, 400, 'invalid_json');
    });

    it('answers a body over 1 MiB with payload_too_large', async () => {
      // In-process (no socket): over a real connection Fastify answers 413 and closes it while the
      // client is still uploading, so the client may see ECONNRESET instead of the response.
      const res = await app.inject({
        method: 'POST',
        url: '/__probe/validate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'x'.repeat(1024 * 1024 + 1) }),
      });

      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body)).toEqual({
        statusCode: 413,
        code: 'payload_too_large',
        message: ERROR_CATALOGUE.payload_too_large.message,
        requestId: res.headers['x-request-id'],
      });
    });

    it('refuses form-encoded bodies: this is a JSON API (D37)', async () => {
      const res = await http()
        .post('/__probe/validate')
        .type('form')
        .send('email=x%40example.com');

      expectEnvelope(res, 415, 'unsupported_media_type');
    });

    it('answers an unsupported content type with unsupported_media_type', async () => {
      const res = await http()
        .post('/__probe/validate')
        .set('Content-Type', 'application/xml')
        .send('<email>x</email>');

      expectEnvelope(res, 415, 'unsupported_media_type');
    });
  });

  describe('routes that do not exist', () => {
    it('answers with not_found and does not echo the method, path or query', async () => {
      const res = await http().get(
        `/no-such-route/${PROBE_SECRET}?q=${PROBE_SECRET}`,
      );

      expectEnvelope(res, 404, 'not_found');
      expect(res.text).not.toContain(PROBE_SECRET);
    });

    it('makes readiness from an outside address indistinguishable from a missing route', async () => {
      const outside = { remoteAddress: '203.0.113.9' };
      const [ready, missing] = await Promise.all([
        app.inject({ method: 'GET', url: '/health/ready', ...outside }),
        app.inject({ method: 'GET', url: '/health/no-such-route', ...outside }),
      ]);

      const strip = (body: string) => {
        const { requestId, ...rest } = JSON.parse(body) as Record<
          string,
          unknown
        >;
        expect(requestId).toEqual(expect.any(String));
        return rest;
      };
      expect(ready.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(strip(ready.body)).toEqual(strip(missing.body));
    });
  });

  describe('exceptions from application code', () => {
    it('replaces the message of a plain Nest exception with the catalogue one', async () => {
      const res = await http().get('/__probe/nest-exception');

      expectEnvelope(res, 403, 'forbidden');
      expect(res.text).not.toContain(PROBE_SECRET);
    });

    it('hides an unexpected error behind internal_error and logs it without its message', async () => {
      logs.clear();

      const res = await http().get('/__probe/unexpected');

      expectEnvelope(res, 500, 'internal_error');
      expect(res.text).not.toContain(PROBE_SECRET);
      const logged = logs.lines().find((line) => line.msg === 'request failed');
      expect(logged).toMatchObject({
        level: 50,
        statusCode: 500,
        errorCode: 'internal_error',
        errorType: 'Error',
        requestId: requestIdOf(res),
      });
      expect(logged?.stack).toEqual(expect.stringContaining('at '));
    });
  });

  describe('database errors', () => {
    it('turns a unique violation into 409 conflict and logs only the constraint name', async () => {
      logs.clear();

      const res = await http().get('/__probe/unique-violation');

      expectEnvelope(res, 409, 'conflict');
      expect(res.text).not.toContain('uq_probe');
      expect(
        logs.lines().find((line) => line.msg === 'request failed'),
      ).toMatchObject({
        level: 40,
        statusCode: 409,
        errorCode: 'conflict',
        dbCode: '23505',
        constraint: 'uq_probe',
      });
    });

    it('turns a statement timeout into 503 service_unavailable', async () => {
      const res = await http().get('/__probe/statement-timeout');

      expectEnvelope(res, 503, 'service_unavailable');
    });

    it('never logs the value Postgres quotes in its error message', async () => {
      logs.clear();

      const res = await http().get('/__probe/db-error-with-value');

      expectEnvelope(res, 500, 'internal_error');
      expect(
        logs.lines().find((line) => line.msg === 'request failed'),
      ).toMatchObject({
        errorType: 'QueryFailedError',
        dbCode: '22P02',
      });
      logs.expectNoLeaks(config, [PROBE_SECRET]);
    });
  });
});
