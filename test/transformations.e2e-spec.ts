import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { UserDataErasers } from '@/modules/erasure/user-data-erasers';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';
import { ConverterRegistry } from '@/modules/transformations/converter-registry';

import { ip } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { type Actor, actorWithRoles, ensureBootstrapped } from './utils/rbac';
import {
  PROBE_LIMITS,
  TransformProbeModule,
} from './utils/transform-probe.module';

const logs = new LogCapture();
const sensitive: string[] = [];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let temp: string;
let member: Actor;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'c15-transform-'));
  ({ app, config } = await createTestApp({
    logs,
    imports: [TransformProbeModule],
    env: { TRANSFORMATION_TEMP_DIR: temp },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  // The app may have started before this database had a `user` role (a fresh CI database):
  // applying the seeds again is what the next start would do.
  await app.get(RbacPermissionSeeds).applyAll();
  member = await actorWithRoles(app, ['user']);
});
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
  await rm(temp, { recursive: true, force: true });
});

/** A multipart body with the given text fields and files, in order. */
function multipart(
  parts: (
    | { field: string; value: string }
    | { file: string; name: string; type?: string; content: string | Buffer }
  )[],
) {
  const boundary = `----c15${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('field' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.file}"; filename="${part.name}"\r\n` +
            `Content-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        Buffer.from(part.content),
        Buffer.from('\r\n'),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function convert(
  actor: Actor | undefined,
  options: {
    mode?: string;
    content?: string | Buffer;
    name?: string;
    target?: string;
    extra?: { field: string; value: string }[];
    headers?: Record<string, string>;
  } = {},
) {
  const fields = [
    { field: 'targetFormat', value: options.target ?? 'upper' },
    ...(options.mode ? [{ field: 'mode', value: options.mode }] : []),
    ...(options.extra ?? []),
  ];
  const body = multipart([
    ...fields,
    {
      file: 'file',
      name: options.name ?? 'secret-report.probe',
      content: options.content ?? 'hello world',
    },
  ]);
  return app.inject({
    method: 'POST',
    url: '/test/transform',
    cookies: actor?.cookies,
    payload: body.payload,
    headers: { ...body.headers, ...options.headers },
    remoteAddress: ip(),
  });
}

async function rows(userId: string) {
  return db.query<
    {
      id: string;
      type: string;
      source_format: string;
      target_format: string;
      status: string;
      input_size: string;
      output_size: string | null;
      duration_ms: number;
      error_code: string | null;
    }[]
  >(
    `SELECT id, type, source_format, target_format, status, input_size, output_size, duration_ms, error_code
       FROM transformations WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
}
const tempIsEmpty = async () => expect(await readdir(temp)).toEqual([]);

async function freshMember() {
  const actor = await actorWithRoles(app, ['user']);
  return actor;
}

describe('permission seed and readiness (spec 2.0 §1.1)', () => {
  it('creates transformations with five actions; user gets convert/history/download, admin all', async () => {
    const actions = await db.query<{ action: string }[]>(
      `SELECT pa.action FROM permission_actions pa JOIN permissions p ON p.id = pa.permission_id
        WHERE p.name = 'transformations' ORDER BY pa.action`,
    );
    expect(actions.map((a) => a.action)).toEqual([
      'convert',
      'download',
      'download_any',
      'history',
      'history_any',
    ]);
    const grants = await db.query<
      { role: string; all_actions: boolean; actions: string[] | null }[]
    >(
      `SELECT r.name AS role, g.all_actions,
              (SELECT array_agg(ga.action ORDER BY ga.action) FROM grant_actions ga WHERE ga.grant_id = g.id) AS actions
         FROM grants g JOIN roles r ON r.id = g.role_id JOIN permissions p ON p.id = g.permission_id
        WHERE p.name = 'transformations' AND r.name IN ('user', 'admin') ORDER BY r.name`,
    );
    expect(grants).toEqual([
      { role: 'admin', all_actions: true, actions: null },
      {
        role: 'user',
        all_actions: false,
        actions: ['convert', 'download', 'history'],
      },
    ]);
  });

  it('applying the seed again changes nothing and never restores a removed grant', async () => {
    const before = await db.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM grants g JOIN permissions p ON p.id = g.permission_id WHERE p.name = 'transformations'`,
    );
    expect(await app.get(RbacPermissionSeeds).applyAll()).toEqual({
      transformations: 'present',
    });
    const after = await db.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM grants g JOIN permissions p ON p.id = g.permission_id WHERE p.name = 'transformations'`,
    );
    expect(after).toEqual(before);
  });

  it('readiness reports the module and the eraser registry up', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
      remoteAddress: '127.0.0.1',
    });
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: {
        transformations: 'up',
        transformation_temp: 'up',
        user_data_erasers: 'up',
      },
    });
  });
});

describe('access before parsing (spec 2.0 §1.3.2 steps 1–3)', () => {
  it('401 without a session', async () => {
    expect((await convert(undefined)).statusCode).toBe(401);
  });

  it('403 without transformations@convert, before the body is read', async () => {
    const outsider = await actorWithRoles(app, []);
    const res = await app.inject({
      method: 'POST',
      url: '/test/transform',
      cookies: outsider.cookies,
      payload: 'not multipart at all',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'permission_denied' });
  });

  it('403 for a cross-origin write without the CSRF header', async () => {
    const res = await convert(member, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'csrf_rejected' });
  });
});

describe('conversion (spec 2.0 §1.3.2 steps 4–9)', () => {
  it('returns the whole result with its headers, writes success, and leaves no temp files', async () => {
    const actor = await freshMember();
    const res = await convert(actor, { content: 'hello world' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('HELLO WORLD');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="converted.upper"',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const [row] = await rows(actor.id);
    expect(res.headers['x-transformation-id']).toBe(row.id);
    expect(row).toMatchObject({
      type: 'file',
      source_format: 'probe',
      target_format: 'upper',
      status: 'success',
      input_size: '11',
      output_size: '11',
      error_code: null,
    });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    await tempIsEmpty();
  });

  it.each([
    ['fail', 400, 'invalid_file', 'invalid_input'],
    ['throw', 503, 'service_unavailable', 'converter_failed'],
    ['bad_code', 503, 'service_unavailable', 'converter_failed'],
    ['big', 413, 'payload_too_large', 'result_too_large'],
  ])(
    'mode %s: %d %s, history error %s, no partial result, no temp files',
    async (mode, status, code, errorCode) => {
      const actor = await freshMember();
      const res = await convert(actor, {
        mode,
        extra:
          mode === 'big'
            ? [{ field: 'size', value: String(PROBE_LIMITS.outputBytes + 1) }]
            : [],
      });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code });
      expect(res.body).not.toContain('library detail');
      expect(res.headers['x-transformation-id']).toBeUndefined();
      const [row] = await rows(actor.id);
      expect(row).toMatchObject({
        status: 'error',
        error_code: errorCode,
        output_size: null,
        input_size: '11',
      });
      await tempIsEmpty();
    },
  );

  it('a result exactly at the limit is fine; a converter that forgets to end its output still completes', async () => {
    const actor = await freshMember();
    const exact = await convert(actor, {
      mode: 'big',
      extra: [{ field: 'size', value: String(PROBE_LIMITS.outputBytes) }],
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.rawPayload.length).toBe(PROBE_LIMITS.outputBytes);
    const noEnd = await convert(actor, { mode: 'no_end', content: 'abc' });
    expect(noEnd.statusCode).toBe(200);
    expect(noEnd.body).toBe('ABC');
  });

  it('a converter past its timeout is terminated: 504, history timeout, other requests keep being served', async () => {
    const actor = await freshMember();
    const started = Date.now();
    const pending = convert(actor, { mode: 'hang' });
    // The event loop is free while the worker spins.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(PROBE_LIMITS.timeoutMs);

    const res = await pending;
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'gateway_timeout' });
    const [row] = await rows(actor.id);
    expect(row).toMatchObject({ status: 'error', error_code: 'timeout' });
    expect(row.duration_ms).toBeGreaterThanOrEqual(PROBE_LIMITS.timeoutMs - 50);
    await tempIsEmpty();

    // The pool replaced the terminated thread.
    const next = await convert(actor, { content: 'again' });
    expect(next.statusCode).toBe(200);
    expect(next.body).toBe('AGAIN');
  });

  it('a failed history write returns no result: 503, temp files removed', async () => {
    const actor = await freshMember();
    type Query = (sql: string, params?: unknown[]) => Promise<unknown>;
    const query: Query = db.query.bind(db) as Query;
    const spy = jest.spyOn(db, 'query').mockImplementation(((
      sql: string,
      params?: unknown[],
    ) =>
      sql.trimStart().startsWith('INSERT INTO transformations')
        ? Promise.reject(
            Object.assign(new Error('connection lost'), {
              code: 'ECONNREFUSED',
            }),
          )
        : query(sql, params)) as never);
    try {
      const res = await convert(actor);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('HELLO');
    } finally {
      spy.mockRestore();
    }
    expect(await rows(actor.id)).toEqual([]);
    await tempIsEmpty();
  });
});

describe('refusals before the pair is known write no history (D65)', () => {
  it.each([
    [
      'an input over the format limit',
      { content: Buffer.alloc(PROBE_LIMITS.inputBytes + 1, 97) },
      413,
    ],
    [
      'an input over the parser limit',
      { content: Buffer.alloc(5000, 97) },
      413,
    ],
    ['an unsupported extension', { name: 'report.exe' }, 415],
    ['an unregistered target', { target: 'sideways' }, 415],
    ['the source as target', { target: 'probe' }, 415],
    ['an empty file', { content: '' }, 400],
    ['an unknown field', { extra: [{ field: 'evil', value: '1' }] }, 400],
    [
      'a repeated field',
      { extra: [{ field: 'targetFormat', value: 'upper' }] },
      400,
    ],
  ])('%s', async (_name, options, status) => {
    const actor = await freshMember();
    const res = await convert(actor, options);
    expect(res.statusCode).toBe(status);
    expect(await rows(actor.id)).toEqual([]);
    await tempIsEmpty();
  });

  it('a missing file, two files, or a body that is not multipart', async () => {
    const actor = await freshMember();
    const send = (body: {
      payload: Buffer | string;
      headers: Record<string, string>;
    }) =>
      app.inject({
        method: 'POST',
        url: '/test/transform',
        cookies: actor.cookies,
        payload: body.payload,
        headers: body.headers,
        remoteAddress: ip(),
      });
    expect(
      (await send(multipart([{ field: 'targetFormat', value: 'upper' }])))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await send(
          multipart([
            { field: 'targetFormat', value: 'upper' },
            { file: 'file', name: 'a.probe', content: 'a' },
            { file: 'file', name: 'b.probe', content: 'b' },
          ]),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send({
          payload: '{"a":1}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(415);
    expect(await rows(actor.id)).toEqual([]);
    await tempIsEmpty();
  });
});

describe('registry (spec 2.0 §1.1, user story 3)', () => {
  it('one converter per direction; a new pair registers beside the existing one', () => {
    const registry = app.get(ConverterRegistry);
    const probe = registry.find('file', 'probe', 'upper')!;
    expect(() => registry.register({ ...probe })).toThrow();
    registry.register({ ...probe, target: 'lower' });
    expect(registry.directions('file')).toContainEqual({
      source: 'probe',
      target: ['upper', 'lower'],
    });
  });
});

describe('eraser and logs (spec 2.0 §1.3.4, §1.5)', () => {
  it("the user-deletion eraser removes the user's history, and only theirs", async () => {
    const gone = await freshMember();
    const kept = await freshMember();
    await convert(gone);
    await convert(kept);
    expect(
      await app.get(UserDataErasers).eraseAll(gone.id, '0'.repeat(32)),
    ).toEqual({ result: 'succeeded' });
    expect(await rows(gone.id)).toEqual([]);
    expect(await rows(kept.id)).toHaveLength(1);
    // Idempotent: a second run finds nothing and still succeeds.
    expect(
      await app.get(UserDataErasers).eraseAll(gone.id, '0'.repeat(32)),
    ).toEqual({ result: 'succeeded' });
  });

  it('logs the operation with safe fields; never the content, file name or temp path', async () => {
    const actor = await freshMember();
    const content = `private-content-${randomUUID()}`;
    const name = `private-name-${randomUUID()}.probe`;
    sensitive.push(content, content.toUpperCase(), name, temp);
    const res = await convert(actor, { content, name });
    expect(res.statusCode).toBe(200);
    const line = logs
      .lines()
      .find(
        (l) =>
          l.event === 'transformation' &&
          l.transformationId === res.headers['x-transformation-id'],
      );
    expect(line).toMatchObject({
      userId: actor.id,
      type: 'file',
      sourceFormat: 'probe',
      targetFormat: 'upper',
      inputSize: content.length,
      outputSize: content.length,
      result: 'success',
      errorCode: null,
    });
    expect(typeof line?.durationMs).toBe('number');
  });
});
