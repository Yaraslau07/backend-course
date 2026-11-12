import { randomBytes } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import { SECRET_KEY_NAMES } from '@/core/config/config.validation';

import { BuiltinReadinessChecks } from './builtin-checks';
import { HealthController, normalizeIp } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';

const key = () => randomBytes(32).toString('base64url');

const fakeConfig = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    READINESS_ALLOWED_IPS: ['127.0.0.1', '::1'],
    USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
    USER_LIST_CURSOR_HMAC_KEYS: [{ kid: 'k1', key: key() }],
    ...Object.fromEntries(SECRET_KEY_NAMES.map((n) => [n, key()])),
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
};

describe('ReadinessRegistry', () => {
  let registry: ReadinessRegistry;
  beforeEach(() => (registry = new ReadinessRegistry()));

  it('is not ready with no checks registered', async () => {
    expect(await registry.run()).toEqual({ status: 'unavailable', checks: {} });
  });

  it('is ready only when every check is up', async () => {
    registry.register('a', () => Promise.resolve('up'));
    registry.register('b', () => Promise.resolve('up'));
    expect(await registry.run()).toEqual({
      status: 'ok',
      checks: { a: 'up', b: 'up' },
    });

    registry.register('c', () =>
      Promise.resolve({ down: 'snapshot_not_loaded' }),
    );
    expect(await registry.run()).toEqual({
      status: 'unavailable',
      checks: { a: 'up', b: 'up', c: 'down' },
    });
  });

  it('counts a throwing or slow check as down', async () => {
    registry.register('throws', () => Promise.reject(new Error('boom')));
    registry.register(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve('up'), 200)),
    );
    const report = await registry.run(20);
    expect(report).toEqual({
      status: 'unavailable',
      checks: { throws: 'down', slow: 'down' },
    });
  });

  it('rejects duplicate names', () => {
    registry.register('a', () => Promise.resolve('up'));
    expect(() => registry.register('a', () => Promise.resolve('up'))).toThrow(
      /already registered/,
    );
    expect(registry.names()).toEqual(['a']);
  });
});

describe('BuiltinReadinessChecks', () => {
  const build = (dataSource: Partial<DataSource>, config = fakeConfig()) => {
    const registry = new ReadinessRegistry();
    const checks = new BuiltinReadinessChecks(
      registry,
      config,
      dataSource as DataSource,
    );
    checks.onModuleInit();
    return { registry, checks };
  };

  it('registers database and config checks that pass when healthy', async () => {
    const { registry } = build({
      isInitialized: true,
      query: jest.fn().mockResolvedValue([]),
    });
    expect(await registry.run()).toEqual({
      status: 'ok',
      checks: { database: 'up', config: 'up' },
    });
  });

  it('reports the database down when not initialized or failing', async () => {
    expect(await build({ isInitialized: false }).checks.database()).toEqual({
      down: 'not_initialized',
    });
    const { registry } = build({
      isInitialized: true,
      query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    expect((await registry.run()).checks.database).toBe('down');
  });

  it('reports config down for a missing key or an unknown active kid', () => {
    const ds = { isInitialized: true };
    expect(
      build(ds, fakeConfig({ JWT_ACCESS_SECRET: undefined })).checks.keys(),
    ).toEqual({ down: 'invalid_key' });
    expect(
      build(
        ds,
        fakeConfig({ USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k2' }),
      ).checks.keys(),
    ).toEqual({
      down: 'cursor_active_kid',
    });
  });
});

describe('HealthController', () => {
  const reply = () => {
    const r = {
      statusCode: 0,
      status: (code: number) => ((r.statusCode = code), r),
    };
    return r;
  };
  const request = (ip: string) => ({ ip }) as FastifyRequest;

  it('liveness is always ok', () => {
    expect(
      new HealthController(new ReadinessRegistry(), fakeConfig()).live(),
    ).toEqual({ status: 'ok' });
  });

  it('readiness hides itself from non-allowed IPs', async () => {
    const controller = new HealthController(
      new ReadinessRegistry(),
      fakeConfig(),
    );
    await expect(
      controller.ready(request('10.1.2.3'), reply() as unknown as FastifyReply),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('readiness returns 200 or 503 for allowed IPs, including IPv4-mapped loopback', async () => {
    const registry = new ReadinessRegistry();
    registry.register('a', () => Promise.resolve('up'));
    const controller = new HealthController(registry, fakeConfig());

    const ok = reply();
    expect(
      await controller.ready(
        request('::ffff:127.0.0.1'),
        ok as unknown as FastifyReply,
      ),
    ).toEqual({
      status: 'ok',
      checks: { a: 'up' },
    });
    expect(ok.statusCode).toBe(200);

    registry.register('b', () => Promise.resolve({ down: 'x' }));
    const down = reply();
    await controller.ready(request('::1'), down as unknown as FastifyReply);
    expect(down.statusCode).toBe(503);
  });

  it('normalizeIp strips the IPv4-mapped prefix only', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
  });
});
