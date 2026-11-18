import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';
import { TransformationRetention } from '@/modules/transformation-history/transformation-retention.service';

import { ip } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import { type Actor, actorWithRoles, ensureBootstrapped } from './utils/rbac';

const logs = new LogCapture();
const sensitive: string[] = [];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let admin: Actor;

beforeAll(async () => {
  ({ app, config } = await createTestApp({ logs }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  await app.get(RbacPermissionSeeds).applyAll();
  admin = await actorWithRoles(app, ['admin']);
});
beforeEach(() => resetRateLimits(app));
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
});

interface Seed {
  type?: 'file' | 'image';
  source?: string;
  target?: string;
  status?: 'success' | 'error';
  createdAt: string;
}

/** History rows written directly, with chosen timestamps (identical ones included). */
async function seed(userId: string, rows: Seed[]): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const status = row.status ?? 'success';
    const [{ id }] = await db.query<{ id: string }[]>(
      `INSERT INTO transformations
         (user_id, type, source_format, target_format, status, input_size, output_size, duration_ms, error_code, created_at)
       VALUES ($1, $2, $3, $4, $5, 10, $6, 7, $7, $8) RETURNING id`,
      [
        userId,
        row.type ?? 'file',
        row.source ?? 'csv',
        row.target ?? 'json',
        status,
        status === 'success' ? 20 : null,
        status === 'error' ? 'invalid_input' : null,
        row.createdAt,
      ],
    );
    ids.push(id);
  }
  return ids;
}

function get(actor: Actor | undefined, url: string) {
  return app.inject({
    method: 'GET',
    url,
    cookies: actor?.cookies,
    remoteAddress: ip(),
  });
}
const own = (actor: Actor, query = '') =>
  get(actor, `/api/transformations/history${query ? `?${query}` : ''}`);
const ofUser = (actor: Actor, userId: string, query = '') =>
  get(
    actor,
    `/admin/users/${userId}/transformations/history${query ? `?${query}` : ''}`,
  );

interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}
/** Every page in order, following nextCursor with the same query. */
async function walk(actor: Actor, query: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 20; n++) {
    const res = await own(
      actor,
      [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
        .filter(Boolean)
        .join('&'),
    );
    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    ids.push(...page.items.map((item) => item.id as string));
    cursor = page.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error('too many pages');
}

describe('own history (spec 2.3 §1.3.2)', () => {
  it('returns the documented item shape: no user id, storage fields fixed until spec 2.4', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const [id] = await seed(actor.id, [
      { createdAt: '2026-11-10T10:00:00.123Z' },
    ]);
    const res = await own(actor);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id,
          type: 'file',
          sourceFormat: 'csv',
          targetFormat: 'json',
          status: 'success',
          inputSize: 10,
          outputSize: 20,
          durationMs: 7,
          errorCode: null,
          createdAt: '2026-11-10T10:00:00.123Z',
          storageStatus: 'not_requested',
          hasStoredFile: false,
          fileExpiresAt: null,
        },
      ],
      nextCursor: null,
    });
    expect(res.body).not.toContain(actor.id);
  });

  it("text and image operations in one list, newest first, only the caller's own", async () => {
    const actor = await actorWithRoles(app, ['user']);
    const other = await actorWithRoles(app, ['user']);
    const [older, newer] = await seed(actor.id, [
      { createdAt: '2026-11-01T00:00:00.000Z' },
      {
        type: 'image',
        source: 'png',
        target: 'jpeg',
        createdAt: '2026-11-02T00:00:00.000Z',
      },
    ]);
    await seed(other.id, [{ createdAt: '2026-11-03T00:00:00.000Z' }]);
    expect((await own(actor)).json<Page>().items.map((i) => i.id)).toEqual([
      newer,
      older,
    ]);
  });

  it('pages through identical created_at values with no gaps or repeats (id DESC breaks ties)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const same = '2026-11-05T12:00:00.000Z';
    const ids = await seed(actor.id, [
      ...Array.from({ length: 7 }, () => ({ createdAt: same })),
      { createdAt: '2026-11-04T00:00:00.000Z' },
      { createdAt: '2026-11-06T00:00:00.000Z' },
    ]);
    const expected = [ids[8], ...ids.slice(0, 7).sort().reverse(), ids[7]];
    expect(await walk(actor, 'limit=2')).toEqual(expected);
    expect(await walk(actor, 'limit=100')).toEqual(expected);
  });

  it('a valid query without results is an empty page', async () => {
    const actor = await actorWithRoles(app, ['user']);
    expect((await own(actor, 'status=error')).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('filters by type, formats, status and the period (from inclusive, to exclusive)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const ids = await seed(actor.id, [
      { createdAt: '2026-11-01T00:00:00.000Z' },
      {
        type: 'image',
        source: 'svg',
        target: 'png',
        createdAt: '2026-11-02T00:00:00.000Z',
      },
      {
        source: 'json',
        target: 'csv',
        status: 'error',
        createdAt: '2026-11-03T00:00:00.000Z',
      },
      { source: 'json', target: 'yaml', createdAt: '2026-11-04T00:00:00.000Z' },
    ]);
    const idsFor = async (query: string) =>
      (await own(actor, query)).json<Page>().items.map((i) => i.id);
    expect(await idsFor('type=image')).toEqual([ids[1]]);
    expect(await idsFor('sourceFormat=json')).toEqual([ids[3], ids[2]]);
    expect(await idsFor('targetFormat=csv')).toEqual([ids[2]]);
    expect(await idsFor('status=error')).toEqual([ids[2]]);
    expect(
      await idsFor(
        'createdAtFrom=2026-11-02T00:00:00Z&createdAtTo=2026-11-04T00:00:00Z',
      ),
    ).toEqual([ids[2], ids[1]]);
    expect(await idsFor('type=file&sourceFormat=json&status=success')).toEqual([
      ids[3],
    ]);
  });

  it('a cursor only continues the exact query it came from (400 otherwise)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    await seed(
      actor.id,
      Array.from({ length: 3 }, (_, i) => ({
        createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
      })),
    );
    const first = (await own(actor, 'limit=1&type=file')).json<Page>();
    const cursor = encodeURIComponent(first.nextCursor!);
    expect(
      (await own(actor, `limit=1&type=file&cursor=${cursor}`)).statusCode,
    ).toBe(200);
    for (const query of [
      `limit=2&type=file&cursor=${cursor}`,
      `limit=1&cursor=${cursor}`,
      `limit=1&type=file&status=success&cursor=${cursor}`,
    ]) {
      const res = await own(actor, query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_cursor' });
    }
    const tampered = Buffer.from('{"v":1}').toString('base64url');
    expect(
      (await own(actor, `limit=1&type=file&cursor=${tampered}`)).statusCode,
    ).toBe(400);
  });

  it.each([
    'limit=0',
    'limit=101',
    'type=audio',
    'sourceFormat=gif',
    'status=pending',
    'createdAtFrom=yesterday',
    'createdAtFrom=2026-11-02T00:00:00Z&createdAtTo=2026-11-01T00:00:00Z',
    'sort=asc',
    'type=file&type=image',
  ])('400 for %s', async (query) => {
    const actor = await actorWithRoles(app, ['user']);
    expect((await own(actor, query)).statusCode).toBe(400);
  });

  it('401 without a session; 403 without transformations@history, before reading', async () => {
    expect(
      (await get(undefined, '/api/transformations/history')).statusCode,
    ).toBe(401);
    const outsider = await actorWithRoles(app, []);
    const res = await own(outsider, 'limit=nonsense');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'permission_denied' });
  });

  it('60 reads per user per minute (429 after)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    for (let n = 0; n < 60; n++)
      expect((await own(actor)).statusCode).toBe(200);
    const limited = await own(actor);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe("someone's history (spec 2.3 §1.3.3)", () => {
  it('admin with history_any gets the target history, filters and pages included', async () => {
    const target = await actorWithRoles(app, ['user']);
    const ids = await seed(target.id, [
      { createdAt: '2026-11-01T00:00:00.000Z' },
      {
        type: 'image',
        source: 'png',
        target: 'jpeg',
        createdAt: '2026-11-02T00:00:00.000Z',
      },
    ]);
    const res = await ofUser(admin, target.id, 'limit=1');
    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    expect(page.items.map((i) => i.id)).toEqual([ids[1]]);
    const next = await ofUser(
      admin,
      target.id,
      `limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(next.json<Page>().items.map((i) => i.id)).toEqual([ids[0]]);
    expect(
      (await ofUser(admin, target.id, 'type=image')).json<Page>().items,
    ).toHaveLength(1);
  });

  it('without history_any it is 403 before the target is looked up, existing or not', async () => {
    const member = await actorWithRoles(app, ['user']);
    const target = await actorWithRoles(app, ['user']);
    for (const id of [target.id, randomUUID()]) {
      const res = await ofUser(member, id);
      expect(res.statusCode).toBe(403);
    }
  });

  it('after the permission, an unknown user is 404 and an invalid id 400', async () => {
    expect((await ofUser(admin, randomUUID())).statusCode).toBe(404);
    expect((await ofUser(admin, 'not-a-uuid')).statusCode).toBe(404);
    expect((await ofUser(admin, 'bad%20id')).statusCode).toBe(400);
  });

  it('a user with no history is an empty page', async () => {
    const target = await actorWithRoles(app, ['user']);
    expect((await ofUser(admin, target.id)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('retention (spec 2.3 §1.3.5, §1.6)', () => {
  it('deletes only rows older than the configured period', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const [old, recent] = await seed(actor.id, [
      { createdAt: new Date(now - 91 * day).toISOString() },
      { createdAt: new Date(now - 89 * day).toISOString() },
    ]);
    expect(await app.get(TransformationRetention).run()).toBeGreaterThanOrEqual(
      1,
    );
    const left = await db.query<{ id: string }[]>(
      `SELECT id FROM transformations WHERE user_id = $1`,
      [actor.id],
    );
    expect(left.map((r) => r.id)).toEqual([recent]);
    expect(left.map((r) => r.id)).not.toContain(old);
  });
});

describe('logs (spec 2.3 §1.5)', () => {
  it('logs actor, scope, target (admin), filter names, limit, count and result; never the cursor', async () => {
    const target = await actorWithRoles(app, ['user']);
    await seed(target.id, [
      { createdAt: '2026-11-01T00:00:00.000Z' },
      { createdAt: '2026-11-02T00:00:00.000Z' },
    ]);
    const first = await ofUser(admin, target.id, 'limit=1&status=success');
    const cursor = first.json<Page>().nextCursor!;
    sensitive.push(cursor);
    const res = await ofUser(
      admin,
      target.id,
      `limit=1&status=success&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res.statusCode).toBe(200);
    const line = logs
      .lines()
      .filter((l) => l.event === 'transformation_history')
      .pop();
    expect(line).toMatchObject({
      actorUserId: admin.id,
      scope: 'admin',
      targetUserId: target.id,
      filters: ['status', 'cursor'],
      limit: 1,
      count: 1,
      result: 'success',
    });
    expect(typeof line?.durationMs).toBe('number');
  });
});
