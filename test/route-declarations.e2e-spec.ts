import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppConfig } from '@/core/config/config.types';

import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import {
  calls,
  INVALID_PROBE_ROUTES,
  RouteProbeModule,
} from './utils/route-probe.module';

/**
 * Spec 1.3 §1.3.2: every route declares public, exactly one permission@action pair, or a receipt
 * (optionally with one pair). A missing or conflicting declaration fails readiness, and a request
 * that reaches such a route gets 503 authorization_unavailable without running the handler.
 * Until the authorization chain lands (C11), protected routes fail closed the same way.
 */
describe('Route declarations (e2e)', () => {
  const logs = new LogCapture();
  let app: NestFastifyApplication;
  let config: AppConfig;

  beforeAll(async () => {
    ({ app, config } = await createTestApp({
      imports: [RouteProbeModule],
      logs,
    }));
  });

  afterAll(async () => {
    logs.expectNoLeaks(config);
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** Runs a request and reports whether the probe handler ran. */
  async function hit(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; code?: unknown; ran: boolean }> {
    const name = path.replace('/__routes/', '');
    const before = calls[name] ?? 0;
    const res = await http().get(path).set(headers);
    return {
      status: res.status,
      code: (res.body as { code?: unknown }).code,
      ran: (calls[name] ?? 0) > before,
    };
  }

  describe('startup scan', () => {
    it('fails readiness when any route is undeclared or misdeclared', async () => {
      const res = await http().get('/health/ready').expect(503);

      expect(res.body).toEqual({
        status: 'unavailable',
        checks: {
          database: 'up',
          config: 'up',
          route_declarations: 'down',
          smtp: 'up',
        },
      });
    });

    it('logs each broken route once, with its reason', () => {
      const reported = logs
        .lines()
        .filter((line) => line.msg === 'route has no valid access declaration');

      expect(reported).toHaveLength(INVALID_PROBE_ROUTES.length);
      for (const expected of INVALID_PROBE_ROUTES) {
        expect(reported).toContainEqual(
          expect.objectContaining({
            level: 50,
            category: 'route_configuration',
            ...expected,
          }),
        );
      }
    });
  });

  describe('requests', () => {
    it('runs a public route, even with a garbage access cookie', async () => {
      expect(await hit('/__routes/public')).toMatchObject({
        status: 200,
        ran: true,
      });
      expect(
        await hit('/__routes/public', { Cookie: 'access_token=not-a-jwt' }),
      ).toMatchObject({ status: 200, ran: true });
    });

    it('runs an internal route (its handler does its own gating)', async () => {
      expect(await hit('/__routes/internal')).toMatchObject({
        status: 200,
        ran: true,
      });
    });

    it.each(INVALID_PROBE_ROUTES.map(({ route }) => route.replace('GET ', '')))(
      'answers %s with 503 authorization_unavailable and does not run it',
      async (path) => {
        expect(await hit(path)).toEqual({
          status: 503,
          code: 'authorization_unavailable',
          ran: false,
        });
      },
    );

    it('fails closed on a protected route until the authorization chain exists', async () => {
      expect(await hit('/__routes/protected')).toEqual({
        status: 503,
        code: 'authorization_unavailable',
        ran: false,
      });
    });

    it('runs a receipt route when the receipt header is present, whatever the cookie', async () => {
      const receipt = { 'Probe-Receipt': 'a'.repeat(32) };

      expect(await hit('/__routes/receipt', receipt)).toMatchObject({
        status: 200,
        ran: true,
      });
      expect(
        await hit('/__routes/receipt-or-pair', {
          ...receipt,
          Cookie: 'access_token=x',
        }),
      ).toMatchObject({ status: 200, ran: true });
    });

    it('answers a receipt-only route without the header with 401 invalid_session', async () => {
      expect(await hit('/__routes/receipt')).toEqual({
        status: 401,
        code: 'invalid_session',
        ran: false,
      });
    });

    it('sends a receipt route without the header down the protected chain', async () => {
      expect(await hit('/__routes/receipt-or-pair')).toEqual({
        status: 503,
        code: 'authorization_unavailable',
        ran: false,
      });
    });

    it('lets a same-origin or non-browser public write through', async () => {
      await http()
        .post('/__routes/public')
        .expect(201, { ran: 'public-write' });
    });
  });

  describe('OpenAPI', () => {
    it('marks protected and receipt-with-pair routes with the cookie scheme, and only those', async () => {
      const res = await http().get('/docs-json').expect(200);
      const paths = (
        res.body as {
          paths: Record<string, Record<string, { security?: unknown }>>;
        }
      ).paths;

      expect(paths['/__routes/protected'].get.security).toEqual([
        { access_token: [] },
      ]);
      expect(paths['/__routes/receipt-or-pair'].get.security).toEqual([
        { access_token: [] },
      ]);
      expect(paths['/__routes/public'].get.security).toBeUndefined();
      expect(paths['/__routes/receipt'].get.security).toBeUndefined();
    });
  });
});
