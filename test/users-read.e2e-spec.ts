import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import {
  ObjectStorage,
  type StorageRead,
} from '@/modules/storage/object-storage';
import type { SafeProfile } from '@/modules/users/safe-profile';
import { UsersReadService } from '@/modules/users/users-read.service';
import { USER_STATUSES } from '@/modules/users/users.types';

import { createUser, ip, setStatus } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { resetRateLimits } from './utils/rate-limits';
import {
  type Actor,
  actorWithRoles,
  bumpPolicy,
  ensureBootstrapped,
  uniqueName,
} from './utils/rbac';

const logs = new LogCapture();
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let admin: Actor;
let reader: Actor;
const secrets: string[] = [];

beforeAll(async () => {
  ({ app, config } = await createTestApp({ logs }));
  db = app.get(DataSource);
  await resetRateLimits(app);
  await ensureBootstrapped(app);
  admin = await actorWithRoles(app, ['admin']);
  reader = await actorWithRoles(app, ['user']);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  logs.expectNoLeaks(config, secrets);
  await app.close();
});

const get = (url: string, actor?: Actor, address = ip()) =>
  app.inject({
    method: 'GET',
    url,
    cookies: actor?.cookies,
    remoteAddress: address,
  });
const list = (params: Record<string, string> = {}, actor = admin) =>
  get(`/admin/users?${new URLSearchParams(params)}`, actor);
const fields = [
  'id',
  'email',
  'displayName',
  'photoUrl',
  'status',
  'createdAt',
  'updatedAt',
].sort();

async function fixture(
  status = 'active',
  extra: { email?: string; name?: string; photo?: string } = {},
) {
  const user = await createUser(app, { email: extra.email });
  await db.query(
    `UPDATE users SET display_name = $2, photo_key = $3 WHERE id = $1`,
    [user.id, extra.name ?? null, extra.photo ?? null],
  );
  if (status !== 'active') await setStatus(app, user.id, status);
  secrets.push(user.email, user.password, extra.name ?? '', extra.photo ?? '');
  return user;
}

describe('profiles and photos (spec 1.4)', () => {
  it('authenticates before validation; requires base permission before lookup', async () => {
    expect((await get('/users/invalid.id')).statusCode).toBe(401);
    const actor = await actorWithRoles(app, []);
    expect((await get(`/users/${randomUUID()}`, actor)).statusCode).toBe(403);
    expect((await get('/users/invalid.id', actor)).statusCode).toBe(403);
    expect((await get('/users/invalid.id', reader)).statusCode).toBe(400);
    expect((await get('/users/valid%0A', reader)).statusCode).toBe(400);
  });

  it('returns exactly the canonical profile and treats an uppercase own UUID as self', async () => {
    const res = await get(`/users/${reader.id.toUpperCase()}`, reader);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(fields);
    expect(res.json()).toMatchObject({
      id: reader.id,
      email: reader.email,
      displayName: null,
      photoUrl: null,
      status: 'active',
    });
    secrets.push(reader.email, reader.cookies.access_token);
  });

  it('checks read_any before looking up an existing, missing or non-UUID target', async () => {
    const target = await fixture();
    for (const id of [target.id, randomUUID(), 'valid-but-absent']) {
      const res = await get(`/users/${id}`, reader);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('ownership_denied');
    }
    expect(logs.text()).not.toContain(target.id);
    for (const id of [randomUUID(), 'valid-but-absent']) {
      expect((await get(`/users/${id}`, admin)).statusCode).toBe(404);
    }
  });

  it.each(USER_STATUSES)(
    'projects a %s target with the same fields',
    async (status) => {
      const target = await fixture(status, {
        name: 'Private Saved Name',
        photo: 'private-photo-key',
      });
      const res = await get(`/users/${target.id}`, admin);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(fields);
      expect(res.json<SafeProfile>().status).toBe(status);
      expect(res.json<SafeProfile>().photoUrl).toBe(
        ['deleting', 'deleted'].includes(status)
          ? null
          : `${config.PUBLIC_API_BASE_URL}/users/${target.id}/photo`,
      );
    },
  );

  it('streams protected WebP bytes with the required response headers', async () => {
    const target = await fixture('active', { photo: 'opaque-image-key' });
    const bytes = Buffer.from('RIFF-normalized-webp-test');
    const read = jest
      .spyOn(app.get(ObjectStorage), 'read')
      .mockResolvedValue({ kind: 'found', stream: Readable.from(bytes) });
    expect((await get(`/users/${target.id}/photo`)).statusCode).toBe(401);
    expect((await get(`/users/${target.id}/photo`, reader)).statusCode).toBe(
      403,
    );
    expect(read).not.toHaveBeenCalled();
    const res = await get(`/users/${target.id}/photo`, admin);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(bytes);
    expect(res.headers).toMatchObject({
      'content-type': 'image/webp',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    });
    expect(read).toHaveBeenCalledWith('opaque-image-key');
  });

  it.each(['not_found', 'unavailable'] as const)(
    'maps storage %s to a safe 503',
    async (kind) => {
      const target = await fixture('active', { photo: 'private-missing-key' });
      jest
        .spyOn(app.get(ObjectStorage), 'read')
        .mockResolvedValue({ kind } as StorageRead);
      const res = await get(`/users/${target.id}/photo`, admin);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('private-missing-key');
    },
  );

  it('returns a safe 503 if the storage stream fails before sending bytes', async () => {
    const target = await fixture('active', { photo: 'private-stream-key' });
    jest.spyOn(app.get(ObjectStorage), 'read').mockResolvedValue({
      kind: 'found',
      stream: new Readable({
        read() {
          this.destroy(new Error('private-stream-key transport detail'));
        },
      }),
    });
    const res = await get(`/users/${target.id}/photo`, admin);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('service_unavailable');
    expect(res.body).not.toContain('private-stream-key');
  });

  it('does not access storage for missing, unset, deleting or deleted photos', async () => {
    const read = jest.spyOn(app.get(ObjectStorage), 'read');
    const ids = [randomUUID(), (await fixture()).id];
    for (const status of ['deleting', 'deleted'])
      ids.push((await fixture(status, { photo: 'hidden-photo' })).id);
    for (const id of ids)
      expect((await get(`/users/${id}/photo`, admin)).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('shares the own-profile/photo budget of 120 and isolates users', async () => {
    const actor = await actorWithRoles(app, ['user']);
    for (let n = 0; n < 120; n++) {
      expect(
        (await get(`/users/${actor.id}${n % 2 ? '/photo' : ''}`, actor))
          .statusCode,
      ).toBe(n % 2 ? 404 : 200);
    }
    const res = await get(`/users/${actor.id}`, actor);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect((await get(`/users/${reader.id}`, reader)).statusCode).toBe(200);
  });

  it('limits foreign profile/photo reads to 60 per actor', async () => {
    const actor = await actorWithRoles(app, ['admin']);
    for (let n = 0; n < 60; n++) {
      expect(
        (await get(`/users/${reader.id}${n % 2 ? '/photo' : ''}`, actor))
          .statusCode,
      ).toBe(n % 2 ? 404 : 200);
    }
    expect((await get(`/users/${reader.id}`, actor)).statusCode).toBe(429);
  });
});

describe('admin user listing (spec 1.7)', () => {
  beforeEach(async () => resetRateLimits(app));

  it('requires users@list before validating the query and does not require users@read', async () => {
    expect((await get('/admin/users?unknown=x')).statusCode).toBe(401);
    expect((await list({ unknown: 'x' }, reader)).statusCode).toBe(403);
    const name = uniqueName('list-only');
    await db.transaction(async (m) => {
      const [role] = await m.query<{ id: string }[]>(
        `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
        [name],
      );
      const [permission] = await m.query<{ id: string }[]>(
        `SELECT id FROM permissions WHERE name = 'users'`,
      );
      const [grant] = await m.query<{ id: string }[]>(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, false) RETURNING id`,
        [role.id, permission.id],
      );
      await m.query(
        `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'list')`,
        [grant.id, permission.id],
      );
    });
    await bumpPolicy(db);
    const actor = await actorWithRoles(app, [name]);
    expect((await list({}, actor)).statusCode).toBe(200);
    expect((await get(`/users/${actor.id}`, actor)).statusCode).toBe(403);
  });

  it('uses the default page size, returns only safe fields, and never reads storage', async () => {
    const read = jest.spyOn(app.get(ObjectStorage), 'read');
    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Record<string, unknown>[];
      nextCursor: string | null;
    }>();
    expect(body.items.length).toBeLessThanOrEqual(20);
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    for (const item of body.items)
      expect(Object.keys(item).sort()).toEqual(fields);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    'unknown=x',
    'limit=0',
    'limit=101',
    'limit=20%0A',
    'limit=1&limit=2',
    'status=bad',
    'sort=email',
    'order=DESC',
    'q=abc',
    'searchBy=email',
    'searchBy=email&q=ab',
    'searchBy=displayName&q=ab%00',
    'cursor=',
  ])('rejects invalid/duplicate query %s', async (query) => {
    expect((await get(`/admin/users?${query}`, admin)).statusCode).toBe(400);
  });

  it('returns 200 with an empty page for a valid search with no matches', async () => {
    const res = await list({ searchBy: 'id', q: 'valid-but-absent' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it.each(['createdAt', 'id'])(
    'walks tied timestamps in both directions with %s and excludes later inserts',
    async (sort) => {
      const prefix = `pages-${randomUUID()}`;
      secrets.push(prefix);
      const users = await Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          fixture('active', { email: `${prefix}-${n}@example.com` }),
        ),
      );
      await db.query(
        `UPDATE users SET created_at = '2026-11-01T00:00:00.123Z' WHERE id = ANY($1::uuid[])`,
        [users.map((u) => u.id)],
      );
      for (const order of ['asc', 'desc']) {
        const params = {
          searchBy: 'email',
          q: prefix,
          sort,
          order,
          limit: '2',
        };
        let res = await list(params);
        const received: string[] = [];
        const late = await fixture('active', {
          email: `${prefix}-late-${order}@example.com`,
        });
        const boundary = await fixture('active', {
          email: `${prefix}-boundary-${order}@example.com`,
        });
        const firstCursor = res.json<{ nextCursor: string }>().nextCursor;
        const { snapshotAt } = JSON.parse(
          Buffer.from(firstCursor.split('.')[0], 'base64url').toString(),
        ) as { snapshotAt: string };
        await db.query(`UPDATE users SET created_at = $2 WHERE id = $1`, [
          boundary.id,
          snapshotAt,
        ]);
        // Its immutable creation time is at/after the first request's snapshot.
        await db.query(
          `UPDATE users SET created_at = clock_timestamp() WHERE id = $1`,
          [late.id],
        );
        for (let n = 0; n < 5; n++) {
          expect(res.statusCode).toBe(200);
          const body = res.json<{
            items: { id: string }[];
            nextCursor: string | null;
          }>();
          received.push(...body.items.map((u) => u.id));
          if (!body.nextCursor) break;
          secrets.push(body.nextCursor);
          res = await list({ ...params, cursor: body.nextCursor });
        }
        const expected = users.map((u) => u.id).sort();
        // Exclude the prior direction's insert from the next traversal's fixture set.
        if (order === 'asc') {
          expect(received).toEqual(expected);
          await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [
            late.id,
            `excluded-${randomUUID()}@example.com`,
          ]);
          await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [
            boundary.id,
            `excluded-${randomUUID()}@example.com`,
          ]);
        } else expect(received).toEqual(expected.reverse());
      }
    },
  );

  it('supports exact ID, literal email/name prefix and all status filters', async () => {
    const prefix = `literal_${randomUUID()}`;
    secrets.push(prefix, `Éva_%${prefix}`, `ÉVA_%${prefix}`);
    const target = await fixture('active', {
      email: `${prefix}@example.com`,
      name: `Éva_%${prefix}`,
    });
    await fixture('active', {
      email: `${prefix.replace('_', 'x')}@example.com`,
      name: 'ÉvaxWrong',
    });
    for (const params of [
      { searchBy: 'id', q: target.id },
      { searchBy: 'email', q: `  ${prefix.toUpperCase()}  ` },
      { searchBy: 'displayName', q: `  E\u0301VA_%${prefix}  ` },
    ]) {
      const res = await list(params);
      expect(res.statusCode).toBe(200);
      expect(
        res
          .json<{ items: SafeProfile[] }>()
          .items.map((u: { id: string }) => u.id),
      ).toEqual([target.id]);
    }
    for (const status of USER_STATUSES) {
      const user = await fixture(status);
      const res = await list({ searchBy: 'id', q: user.id, status });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: SafeProfile[] }>().items).toHaveLength(1);
      expect(res.json<{ items: SafeProfile[] }>().items[0].status).toBe(status);
    }
  });

  it('rejects altered signatures and changed parameters with invalid_cursor', async () => {
    const res = await list({ limit: '1' });
    const cursor = res.json<{ nextCursor: string }>().nextCursor;
    expect(cursor).toBeTruthy();
    secrets.push(cursor);
    for (const params of [
      { limit: '2', cursor },
      { limit: '1', cursor: `${cursor.slice(0, -2)}xx` },
      { limit: '1', cursor, status: 'active' },
    ]) {
      const invalid = await list(params as Record<string, string>);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<{ code: string }>().code).toBe('invalid_cursor');
    }
  });

  it('an expired cursor is invalid_cursor, and one is fine until its 15 minutes pass (spec 1.7 §1.3.4)', async () => {
    const res = await list({ limit: '1' });
    const cursor = res.json<{ nextCursor: string }>().nextCursor;
    secrets.push(cursor);
    const real = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(real + 14 * 60 * 1000);
      expect((await list({ limit: '1', cursor })).statusCode).toBe(200);
      clock.mockReturnValue(real + 15 * 60 * 1000 + 1000);
      const expired = await list({ limit: '1', cursor });
      expect(expired.statusCode).toBe(400);
      expect(expired.json<{ code: string }>().code).toBe('invalid_cursor');
    } finally {
      clock.mockRestore();
    }
  });

  it('limits the actor to 60 requests and a shared IP to 120', async () => {
    const actor = await actorWithRoles(app, ['admin']);
    for (let n = 0; n < 60; n++)
      expect(
        (await list({ searchBy: 'id', q: 'absent' }, actor)).statusCode,
      ).toBe(200);
    expect((await list({}, actor)).statusCode).toBe(429);
    await resetRateLimits(app);
    const actors = await Promise.all(
      Array.from({ length: 3 }, () => actorWithRoles(app, ['admin'])),
    );
    const address = ip();
    for (let n = 0; n < 120; n++)
      expect(
        (await get('/admin/users?searchBy=id&q=absent', actors[n % 3], address))
          .statusCode,
      ).toBe(200);
    expect((await get('/admin/users', actors[0], address)).statusCode).toBe(
      429,
    );
  });

  it('returns 503 on a real two-second SQL timeout and recovers on the next request', async () => {
    const lock = db.createQueryRunner();
    await lock.connect();
    await lock.startTransaction();
    const service = app.get<UsersReadService>(UsersReadService);
    const original = service.list.bind(service) as UsersReadService['list'];
    jest.spyOn(service, 'list').mockImplementationOnce(async (actor, query) => {
      // Acquire after the request's identity/RBAC reads, so only the bounded list query waits.
      await lock.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
      return original(actor, query);
    });
    try {
      const res = await list();
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe('service_unavailable');
      expect(res.body).not.toContain('items');
    } finally {
      await lock.rollbackTransaction();
      await lock.release();
    }
    expect((await list()).statusCode).toBe(200);
  });
});
