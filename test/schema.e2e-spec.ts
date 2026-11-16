import { DataSource, QueryFailedError, QueryRunner } from 'typeorm';

import { createTestDataSource } from './utils/test-data-source';

/**
 * The Part 1 schema, tested at the database level: every rule the specs push down to Postgres
 * (unique email, the deleted-state CHECK, one outstanding challenge per user, one deletion job per user, …)
 * must hold even if application code has a bug. Each test runs in a transaction that is rolled back.
 */

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const NOT_NULL = '23502';
const BAD_ENUM = '22P02';

const HASH = Buffer.alloc(32, 7);
const JOB_ID = 'a'.repeat(32);
const TOMBSTONE = `deleted.${'b'.repeat(32)}@example.invalid`;

interface Violation {
  code: string;
  constraint?: string;
}

describe('Part 1 database schema (e2e)', () => {
  let dataSource: DataSource;
  let qr: QueryRunner;
  let emailCounter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
  });

  afterEach(async () => {
    await qr.rollbackTransaction();
    await qr.release();
  });

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await qr.query(sql, params)) as T[];
  }

  /** Runs a statement that must fail and returns the Postgres error code and constraint name. */
  async function violation(
    sql: string,
    params: unknown[] = [],
  ): Promise<Violation> {
    await qr.query('SAVEPOINT expected_violation');
    try {
      await qr.query(sql, params);
    } catch (error) {
      await qr.query('ROLLBACK TO SAVEPOINT expected_violation');
      if (!(error instanceof QueryFailedError)) throw error;
      const driverError = error.driverError as Violation;
      return { code: driverError.code, constraint: driverError.constraint };
    }
    throw new Error(`Expected the statement to be rejected: ${sql}`);
  }

  async function createUser(status = 'active'): Promise<string> {
    emailCounter += 1;
    const [user] = await rows<{ id: string }>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, 'hash', $2) RETURNING id`,
      [`user-${emailCounter}@schema-spec.invalid`, status],
    );
    return user.id;
  }

  async function createRole(name: string): Promise<string> {
    const [role] = await rows<{ id: string }>(
      `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
      [name],
    );
    return role.id;
  }

  async function createPermission(
    name: string,
    actions: string[],
  ): Promise<string> {
    const [permission] = await rows<{ id: string }>(
      `INSERT INTO permissions (name) VALUES ($1) RETURNING id`,
      [name],
    );
    for (const action of actions) {
      await qr.query(
        `INSERT INTO permission_actions (permission_id, action) VALUES ($1, $2)`,
        [permission.id, action],
      );
    }
    return permission.id;
  }

  async function createGrant(
    roleId: string,
    permissionId: string,
    allActions: boolean,
  ): Promise<string> {
    const [grant] = await rows<{ id: string }>(
      `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, $3) RETURNING id`,
      [roleId, permissionId, allActions],
    );
    return grant.id;
  }

  describe('users', () => {
    it('fills id and both timestamps from the database, with millisecond precision', async () => {
      const [user] = await rows<{
        id: string;
        created_at: Date;
        updated_at: Date;
        created_text: string;
        display_name: string | null;
        photo_key: string | null;
      }>(
        `INSERT INTO users (email, password_hash, status) VALUES ('new@schema-spec.invalid', 'hash', 'pending')
         RETURNING id, created_at, updated_at, created_at::text AS created_text, display_name, photo_key`,
      );

      expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.created_at).toBeInstanceOf(Date);
      expect(user.updated_at.getTime()).toBe(user.created_at.getTime());
      // No microseconds: a JS Date (and so a list cursor) round-trips the stored value exactly.
      expect(user.created_text).toMatch(/^[^.]+(\.\d{1,3})?[+-]\d/);
      expect(user.display_name).toBeNull();
      expect(user.photo_key).toBeNull();
    });

    it('accepts exactly the five statuses', async () => {
      for (const status of ['pending', 'active', 'blocked', 'deleting']) {
        await createUser(status);
      }
      await qr.query(
        `INSERT INTO users (email, password_hash, status) VALUES ('gone@schema-spec.invalid', NULL, 'deleted')`,
      );

      expect(
        await violation(
          `INSERT INTO users (email, password_hash, status) VALUES ('x@schema-spec.invalid', 'hash', 'archived')`,
        ),
      ).toMatchObject({ code: BAD_ENUM });
    });

    it('rejects a second user with the same email', async () => {
      await qr.query(
        `INSERT INTO users (email, password_hash, status) VALUES ('dup@schema-spec.invalid', 'hash', 'active')`,
      );

      expect(
        await violation(
          `INSERT INTO users (email, password_hash, status) VALUES ('dup@schema-spec.invalid', 'hash', 'pending')`,
        ),
      ).toEqual({ code: UNIQUE, constraint: 'uq_users_email' });
    });

    it('treats user+tag@schema-spec.invalid as a separate address', async () => {
      await qr.query(
        `INSERT INTO users (email, password_hash, status) VALUES ('user@schema-spec.invalid', 'hash', 'active'),
                                                                  ('user+tag@schema-spec.invalid', 'hash', 'active')`,
      );
    });

    it('rejects an email with outer whitespace or longer than 254 characters', async () => {
      for (const email of [
        ' padded@schema-spec.invalid',
        'padded@schema-spec.invalid ',
        'padded@schema-spec.invalid\n',
        '\tpadded@schema-spec.invalid',
        `${'a'.repeat(236)}@schema-spec.invalid`,
      ]) {
        expect(
          await violation(
            `INSERT INTO users (email, password_hash, status) VALUES ($1, 'hash', 'active')`,
            [email],
          ),
        ).toEqual({ code: CHECK, constraint: 'ck_users_email' });
      }
    });

    it('rejects an empty display name or one longer than 80 code points', async () => {
      const id = await createUser();

      expect(
        await violation(`UPDATE users SET display_name = '' WHERE id = $1`, [
          id,
        ]),
      ).toEqual({ code: CHECK, constraint: 'ck_users_display_name' });
      expect(
        await violation(`UPDATE users SET display_name = $2 WHERE id = $1`, [
          id,
          'x'.repeat(81),
        ]),
      ).toEqual({ code: CHECK, constraint: 'ck_users_display_name' });

      // 80 code points that are 320 bytes: the limit counts code points, not bytes.
      await qr.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [
        id,
        '😀'.repeat(80),
      ]);
    });

    it('allows a null password hash only for a deleted user', async () => {
      for (const status of ['pending', 'active', 'blocked', 'deleting']) {
        expect(
          await violation(
            `INSERT INTO users (email, password_hash, status) VALUES ('nohash@schema-spec.invalid', NULL, $1)`,
            [status],
          ),
        ).toEqual({ code: CHECK, constraint: 'ck_users_deleted_state' });
      }
    });

    it('requires a deleted user to have no password hash, display name or photo key', async () => {
      const id = await createUser('deleting');
      await qr.query(
        `UPDATE users SET display_name = 'Name', photo_key = 'key' WHERE id = $1`,
        [id],
      );

      const attempts = [
        `UPDATE users SET status = 'deleted' WHERE id = $1`,
        `UPDATE users SET status = 'deleted', password_hash = NULL WHERE id = $1`,
        `UPDATE users SET status = 'deleted', password_hash = NULL, display_name = NULL WHERE id = $1`,
        `UPDATE users SET status = 'deleted', password_hash = NULL, photo_key = NULL WHERE id = $1`,
      ];
      for (const sql of attempts) {
        expect(await violation(sql, [id])).toEqual({
          code: CHECK,
          constraint: 'ck_users_deleted_state',
        });
      }

      await qr.query(
        `UPDATE users SET status = 'deleted', email = $2, password_hash = NULL, display_name = NULL, photo_key = NULL
         WHERE id = $1`,
        [id, TOMBSTONE],
      );
    });
  });

  describe.each([
    ['registration_challenges', ''],
    ['login_challenges', ''],
    ['email_change_challenges', 'new@schema-spec.invalid'],
    ['deletion_challenges', ''],
  ])('%s', (table, newEmail) => {
    const extraColumn = newEmail ? ', new_email' : '';
    const extraValue = newEmail ? `, '${newEmail}'` : '';
    const insert = `INSERT INTO ${table} (user_id, method, secret_hash${extraColumn})
                    VALUES ($1, $2, $3${extraValue}) RETURNING id`;

    async function createChallenge(
      userId: string,
      method = 'otp',
    ): Promise<string> {
      const [challenge] = await rows<{ id: string }>(insert, [
        userId,
        method,
        HASH,
      ]);
      return challenge.id;
    }

    it('starts unconsumed with zero attempts and a database send time', async () => {
      const id = await createChallenge(await createUser());
      const [challenge] = await rows<{
        attempts: number;
        last_sent_at: Date;
        consumed_at: Date | null;
        consumed_reason: string | null;
      }>(
        `SELECT attempts, last_sent_at, consumed_at, consumed_reason FROM ${table} WHERE id = $1`,
        [id],
      );

      expect(challenge.attempts).toBe(0);
      expect(challenge.last_sent_at).toBeInstanceOf(Date);
      expect(challenge.consumed_at).toBeNull();
      expect(challenge.consumed_reason).toBeNull();
    });

    it('allows only one outstanding challenge per user', async () => {
      const userId = await createUser();
      const first = await createChallenge(userId);

      expect(await violation(insert, [userId, 'otp', HASH])).toEqual({
        code: UNIQUE,
        constraint: `uq_${table}_outstanding`,
      });

      // Once the first is consumed, a new one can be issued; consumed rows don't count.
      await qr.query(
        `UPDATE ${table} SET consumed_at = now(), consumed_reason = 'replaced' WHERE id = $1`,
        [first],
      );
      const second = await createChallenge(userId, 'magic_link');
      await qr.query(
        `UPDATE ${table} SET consumed_at = now(), consumed_reason = 'confirmed' WHERE id = $1`,
        [second],
      );
      await createChallenge(userId);
    });

    it('lets different users each hold an outstanding challenge', async () => {
      await createChallenge(await createUser());
      await createChallenge(await createUser());
    });

    it('accepts only otp and magic_link as the method', async () => {
      expect(
        await violation(insert, [await createUser(), 'sms', HASH]),
      ).toMatchObject({ code: BAD_ENUM });
    });

    it('keeps attempts between 0 and 5', async () => {
      const id = await createChallenge(await createUser());
      await qr.query(`UPDATE ${table} SET attempts = 5 WHERE id = $1`, [id]);

      for (const attempts of [6, -1]) {
        expect(
          await violation(`UPDATE ${table} SET attempts = $2 WHERE id = $1`, [
            id,
            attempts,
          ]),
        ).toEqual({ code: CHECK, constraint: `ck_${table}_attempts` });
      }
    });

    it('requires consumed_at and consumed_reason together', async () => {
      const id = await createChallenge(await createUser());

      expect(
        await violation(
          `UPDATE ${table} SET consumed_at = now() WHERE id = $1`,
          [id],
        ),
      ).toEqual({ code: CHECK, constraint: `ck_${table}_consumed` });
      expect(
        await violation(
          `UPDATE ${table} SET consumed_reason = 'confirmed' WHERE id = $1`,
          [id],
        ),
      ).toEqual({ code: CHECK, constraint: `ck_${table}_consumed` });
    });

    it('accepts every documented consumed reason and nothing else', async () => {
      const reasons = [
        'confirmed',
        'replaced',
        'attempts_exhausted',
        'user_inactive',
        'admin_override',
        'email_conflict',
        'job_exists',
      ];
      for (const reason of reasons) {
        const id = await createChallenge(await createUser());
        await qr.query(
          `UPDATE ${table} SET consumed_at = now(), consumed_reason = $2 WHERE id = $1`,
          [id, reason],
        );
      }

      const id = await createChallenge(await createUser());
      expect(
        await violation(
          `UPDATE ${table} SET consumed_at = now(), consumed_reason = 'expired' WHERE id = $1`,
          [id],
        ),
      ).toMatchObject({ code: BAD_ENUM });
    });

    it('stores the secret only as a 32-byte HMAC', async () => {
      expect(
        await violation(insert, [
          await createUser(),
          'otp',
          Buffer.from('123456'),
        ]),
      ).toEqual({ code: CHECK, constraint: `ck_${table}_secret_hash` });
    });

    it('requires an existing user', async () => {
      expect(
        await violation(insert, [
          '00000000-0000-4000-8000-000000000000',
          'otp',
          HASH,
        ]),
      ).toEqual({ code: FOREIGN_KEY, constraint: `fk_${table}_user` });
    });
  });

  describe('email_change_challenges', () => {
    it('requires the target address', async () => {
      expect(
        await violation(
          `INSERT INTO email_change_challenges (user_id, method, secret_hash) VALUES ($1, 'otp', $2)`,
          [await createUser(), HASH],
        ),
      ).toMatchObject({ code: NOT_NULL });
    });

    it('rejects a target address with outer whitespace or longer than 254 characters', async () => {
      for (const newEmail of [
        ' new@schema-spec.invalid',
        'new@schema-spec.invalid\n',
        `${'a'.repeat(236)}@schema-spec.invalid`,
      ]) {
        expect(
          await violation(
            `INSERT INTO email_change_challenges (user_id, method, secret_hash, new_email) VALUES ($1, 'otp', $2, $3)`,
            [await createUser(), HASH, newEmail],
          ),
        ).toEqual({
          code: CHECK,
          constraint: 'ck_email_change_challenges_new_email',
        });
      }
    });
  });

  describe('RBAC', () => {
    it('has exactly one policy state row, created by the migration', async () => {
      // Other suites bump the version in this shared database, so only its shape is asserted.
      const state = await rows<{ id: number; version: string }>(
        `SELECT id, version FROM rbac_policy_state`,
      );

      expect(state).toHaveLength(1);
      expect(state[0].id).toBe(1);
      expect(state[0].version).toMatch(/^\d+$/);
    });

    it('never lets the policy version go negative', async () => {
      expect(
        await violation(`UPDATE rbac_policy_state SET version = -1`),
      ).toEqual({ code: CHECK, constraint: 'ck_rbac_policy_state_version' });
    });

    it('cannot hold a second policy state row', async () => {
      expect(
        await violation(`INSERT INTO rbac_policy_state (id) VALUES (2)`),
      ).toEqual({
        code: CHECK,
        constraint: 'ck_rbac_policy_state_single_row',
      });
      expect(
        await violation(`INSERT INTO rbac_policy_state (id) VALUES (1)`),
      ).toEqual({ code: UNIQUE, constraint: 'pk_rbac_policy_state' });
    });

    it.each([
      ['roles', 'uq_roles_name', 'ck_roles_name'],
      ['permissions', 'uq_permissions_name', 'ck_permissions_name'],
    ])(
      '%s: unique normalized name in the documented format',
      async (table, unique, check) => {
        await qr.query(`INSERT INTO ${table} (name) VALUES ('schema.test-1')`);

        expect(
          await violation(
            `INSERT INTO ${table} (name) VALUES ('schema.test-1')`,
          ),
        ).toEqual({ code: UNIQUE, constraint: unique });

        for (const name of ['Admin', '1admin', '', 'a b', 'a'.repeat(65)]) {
          expect(
            await violation(`INSERT INTO ${table} (name) VALUES ($1)`, [name]),
          ).toEqual({ code: CHECK, constraint: check });
        }
        await qr.query(`INSERT INTO ${table} (name) VALUES ($1)`, [
          'a'.repeat(64),
        ]);
      },
    );

    it.each(['roles', 'permissions'])(
      '%s: description is at most 500 characters and never an empty string',
      async (table) => {
        await qr.query(
          `INSERT INTO ${table} (name, description) VALUES ('with-description', $1)`,
          ['d'.repeat(500)],
        );
        for (const description of ['d'.repeat(501), '']) {
          expect(
            await violation(
              `INSERT INTO ${table} (name, description) VALUES ('bad-description', $1)`,
              [description],
            ),
          ).toEqual({ code: CHECK, constraint: `ck_${table}_description` });
        }
      },
    );

    it('keeps actions unique per permission and in the documented format', async () => {
      const permissionId = await createPermission('schema-perm', ['read']);

      expect(
        await violation(
          `INSERT INTO permission_actions (permission_id, action) VALUES ($1, 'read')`,
          [permissionId],
        ),
      ).toEqual({ code: UNIQUE, constraint: 'pk_permission_actions' });
      expect(
        await violation(
          `INSERT INTO permission_actions (permission_id, action) VALUES ($1, 'Read Any')`,
          [permissionId],
        ),
      ).toEqual({ code: CHECK, constraint: 'ck_permission_actions_action' });
    });

    it('allows one grant per role and permission pair', async () => {
      const roleId = await createRole('schema-role');
      const permissionId = await createPermission('schema-perm', ['read']);
      await createGrant(roleId, permissionId, true);

      expect(
        await violation(
          `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, false)`,
          [roleId, permissionId],
        ),
      ).toEqual({ code: UNIQUE, constraint: 'uq_grants_role_permission' });
    });

    it('lets a grant list only actions that belong to its own permission', async () => {
      const roleId = await createRole('schema-role');
      const usersId = await createPermission('schema-users', ['read']);
      const otherId = await createPermission('schema-other', ['manage']);
      const grantId = await createGrant(roleId, usersId, false);

      await qr.query(
        `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'read')`,
        [grantId, usersId],
      );

      // An action the permission doesn't have.
      expect(
        await violation(
          `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'write')`,
          [grantId, usersId],
        ),
      ).toEqual({
        code: FOREIGN_KEY,
        constraint: 'fk_grant_actions_permission_action',
      });
      // A real action, but of another permission than the grant's.
      expect(
        await violation(
          `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'manage')`,
          [grantId, otherId],
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_grant_actions_grant' });
    });

    it('refuses to remove an action that a grant lists explicitly', async () => {
      const roleId = await createRole('schema-role');
      const permissionId = await createPermission('schema-perm', [
        'read',
        'list',
      ]);
      const grantId = await createGrant(roleId, permissionId, false);
      await qr.query(
        `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'read')`,
        [grantId, permissionId],
      );

      expect(
        await violation(
          `DELETE FROM permission_actions WHERE permission_id = $1 AND action = 'read'`,
          [permissionId],
        ),
      ).toEqual({
        code: FOREIGN_KEY,
        constraint: 'fk_grant_actions_permission_action',
      });
      // An action no grant lists can go.
      await qr.query(
        `DELETE FROM permission_actions WHERE permission_id = $1 AND action = 'list'`,
        [permissionId],
      );
    });

    it('refuses to delete a role or permission that is still granted', async () => {
      const roleId = await createRole('schema-role');
      const permissionId = await createPermission('schema-perm', ['read']);
      const grantId = await createGrant(roleId, permissionId, true);

      expect(
        await violation(`DELETE FROM roles WHERE id = $1`, [roleId]),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_grants_role' });
      expect(
        await violation(`DELETE FROM permissions WHERE id = $1`, [
          permissionId,
        ]),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_grants_permission' });

      // Removing the grant frees both, and the permission takes its actions with it.
      await qr.query(`DELETE FROM grants WHERE id = $1`, [grantId]);
      await qr.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
      await qr.query(`DELETE FROM permissions WHERE id = $1`, [permissionId]);
      expect(
        await rows(
          `SELECT 1 FROM permission_actions WHERE permission_id = $1`,
          [permissionId],
        ),
      ).toEqual([]);
    });

    it('deleting a grant removes its explicit actions', async () => {
      const roleId = await createRole('schema-role');
      const permissionId = await createPermission('schema-perm', ['read']);
      const grantId = await createGrant(roleId, permissionId, false);
      await qr.query(
        `INSERT INTO grant_actions (grant_id, permission_id, action) VALUES ($1, $2, 'read')`,
        [grantId, permissionId],
      );

      await qr.query(`DELETE FROM grants WHERE id = $1`, [grantId]);

      expect(
        await rows(`SELECT 1 FROM grant_actions WHERE grant_id = $1`, [
          grantId,
        ]),
      ).toEqual([]);
    });

    it('assigns a role to a user at most once, and only existing ones', async () => {
      const userId = await createUser();
      const roleId = await createRole('schema-role');
      await qr.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [userId, roleId],
      );

      expect(
        await violation(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
          [userId, roleId],
        ),
      ).toEqual({ code: UNIQUE, constraint: 'pk_user_roles' });
      expect(
        await violation(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, '00000000-0000-4000-8000-000000000000')`,
          [userId],
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_user_roles_role' });
      expect(
        await violation(
          `INSERT INTO user_roles (user_id, role_id) VALUES ('00000000-0000-4000-8000-000000000000', $1)`,
          [roleId],
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_user_roles_user' });
    });

    it('refuses to delete a role that is assigned to a user', async () => {
      const userId = await createUser();
      const roleId = await createRole('schema-role');
      await qr.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [userId, roleId],
      );

      expect(
        await violation(`DELETE FROM roles WHERE id = $1`, [roleId]),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_user_roles_role' });
    });
  });

  describe('deletion_jobs', () => {
    const insert = `INSERT INTO deletion_jobs (id, user_id, status, next_attempt_at, tombstone_email)
                    VALUES ($1, $2, 'queued', now(), $3)`;

    it('uses the client Idempotency-Key (32 lowercase hex) as its id', async () => {
      const userId = await createUser('deleting');
      await qr.query(insert, [JOB_ID, userId, TOMBSTONE]);

      for (const id of ['A'.repeat(32), 'a'.repeat(31), 'g'.repeat(32)]) {
        expect(
          await violation(insert, [id, await createUser(), TOMBSTONE]),
        ).toEqual({ code: CHECK, constraint: 'ck_deletion_jobs_id' });
      }
      expect(
        await violation(insert, [
          JOB_ID,
          await createUser(),
          `deleted.${'c'.repeat(32)}@example.invalid`,
        ]),
      ).toEqual({ code: UNIQUE, constraint: 'pk_deletion_jobs' });
    });

    it('allows one job per user', async () => {
      const userId = await createUser('deleting');
      await qr.query(insert, [JOB_ID, userId, TOMBSTONE]);

      expect(
        await violation(insert, [
          'c'.repeat(32),
          userId,
          `deleted.${'c'.repeat(32)}@example.invalid`,
        ]),
      ).toEqual({ code: UNIQUE, constraint: 'uq_deletion_jobs_user' });
    });

    it('keeps tombstones unique and in the documented format', async () => {
      await qr.query(insert, [JOB_ID, await createUser(), TOMBSTONE]);

      expect(
        await violation(insert, [
          'c'.repeat(32),
          await createUser(),
          TOMBSTONE,
        ]),
      ).toEqual({
        code: UNIQUE,
        constraint: 'uq_deletion_jobs_tombstone_email',
      });
      expect(
        await violation(insert, [
          'c'.repeat(32),
          await createUser(),
          'deleted.user@schema-spec.invalid',
        ]),
      ).toEqual({
        code: CHECK,
        constraint: 'ck_deletion_jobs_tombstone_email',
      });
    });

    it('keeps status, lease, next attempt and finish time consistent', async () => {
      const userId = await createUser('deleting');
      await qr.query(insert, [JOB_ID, userId, TOMBSTONE]);
      const state = { code: CHECK, constraint: 'ck_deletion_jobs_state' };

      // queued needs a next attempt; running needs a lease and no next attempt.
      expect(
        await violation(
          `UPDATE deletion_jobs SET next_attempt_at = NULL WHERE id = $1`,
          [JOB_ID],
        ),
      ).toEqual(state);
      expect(
        await violation(
          `UPDATE deletion_jobs SET status = 'running' WHERE id = $1`,
          [JOB_ID],
        ),
      ).toEqual(state);
      await qr.query(
        `UPDATE deletion_jobs SET status = 'running', lease_until = now() + interval '300 seconds',
                                  next_attempt_at = NULL, attempts = attempts + 1 WHERE id = $1`,
        [JOB_ID],
      );

      // succeeded needs finished_at; nothing else may carry it.
      expect(
        await violation(
          `UPDATE deletion_jobs SET status = 'succeeded', lease_until = NULL WHERE id = $1`,
          [JOB_ID],
        ),
      ).toEqual(state);
      expect(
        await violation(
          `UPDATE deletion_jobs SET status = 'failed', lease_until = NULL, finished_at = now() WHERE id = $1`,
          [JOB_ID],
        ),
      ).toEqual(state);
      await qr.query(
        `UPDATE deletion_jobs SET status = 'failed', lease_until = NULL, last_error_code = 'storage_unavailable'
         WHERE id = $1`,
        [JOB_ID],
      );
      await qr.query(
        `UPDATE deletion_jobs SET status = 'queued', next_attempt_at = now(), attempts = 0, last_error_code = NULL
         WHERE id = $1`,
        [JOB_ID],
      );
      await qr.query(
        `UPDATE deletion_jobs SET status = 'succeeded', next_attempt_at = NULL, finished_at = now() WHERE id = $1`,
        [JOB_ID],
      );
    });

    it('caps automatic starts at 5', async () => {
      await qr.query(insert, [JOB_ID, await createUser(), TOMBSTONE]);

      expect(
        await violation(`UPDATE deletion_jobs SET attempts = 6 WHERE id = $1`, [
          JOB_ID,
        ]),
      ).toEqual({ code: CHECK, constraint: 'ck_deletion_jobs_attempts' });
    });

    it('requires an existing user', async () => {
      expect(
        await violation(insert, [
          JOB_ID,
          '00000000-0000-4000-8000-000000000000',
          TOMBSTONE,
        ]),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'fk_deletion_jobs_user' });
    });
  });

  describe('storage_cleanup_jobs', () => {
    it('starts queued with zero attempts and is due immediately', async () => {
      const [job] = await rows<{
        id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date | null;
      }>(
        `INSERT INTO storage_cleanup_jobs (storage_key, reason) VALUES ('opaque-key', 'photo_replaced')
         RETURNING id, status, attempts, next_attempt_at`,
      );

      expect(job.status).toBe('queued');
      expect(job.attempts).toBe(0);
      expect(job.next_attempt_at).toBeInstanceOf(Date);
    });

    it('accepts only the documented reasons', async () => {
      await qr.query(
        `INSERT INTO storage_cleanup_jobs (storage_key, reason) VALUES ('opaque-key', 'photo_cleared')`,
      );
      expect(
        await violation(
          `INSERT INTO storage_cleanup_jobs (storage_key, reason) VALUES ('opaque-key', 'because')`,
        ),
      ).toMatchObject({ code: BAD_ENUM });
    });

    it('caps attempts at 5 and keeps status and next attempt consistent', async () => {
      const [job] = await rows<{ id: string }>(
        `INSERT INTO storage_cleanup_jobs (storage_key, reason) VALUES ('opaque-key', 'photo_cleared') RETURNING id`,
      );

      expect(
        await violation(
          `UPDATE storage_cleanup_jobs SET attempts = 6 WHERE id = $1`,
          [job.id],
        ),
      ).toEqual({
        code: CHECK,
        constraint: 'ck_storage_cleanup_jobs_attempts',
      });
      expect(
        await violation(
          `UPDATE storage_cleanup_jobs SET next_attempt_at = NULL WHERE id = $1`,
          [job.id],
        ),
      ).toEqual({ code: CHECK, constraint: 'ck_storage_cleanup_jobs_state' });
      expect(
        await violation(
          `UPDATE storage_cleanup_jobs SET status = 'failed' WHERE id = $1`,
          [job.id],
        ),
      ).toEqual({ code: CHECK, constraint: 'ck_storage_cleanup_jobs_state' });

      await qr.query(
        `UPDATE storage_cleanup_jobs SET status = 'failed', attempts = 5, next_attempt_at = NULL WHERE id = $1`,
        [job.id],
      );
    });
  });

  describe('indexes', () => {
    it.each([
      [
        'idx_deletion_jobs_claim',
        'deletion_jobs',
        '(status, next_attempt_at, lease_until)',
      ],
      [
        'idx_storage_cleanup_jobs_claim',
        'storage_cleanup_jobs',
        '(status, next_attempt_at)',
      ],
      ['idx_user_roles_role', 'user_roles', '(role_id)'],
      ['idx_grants_permission', 'grants', '(permission_id)'],
      [
        'idx_grant_actions_permission_action',
        'grant_actions',
        '(permission_id, action)',
      ],
      [
        'idx_registration_challenges_secret_hash',
        'registration_challenges',
        '(secret_hash)',
      ],
      [
        'idx_registration_challenges_user',
        'registration_challenges',
        '(user_id)',
      ],
      ['idx_login_challenges_user', 'login_challenges', '(user_id)'],
      [
        'idx_email_change_challenges_user',
        'email_change_challenges',
        '(user_id)',
      ],
      ['idx_deletion_challenges_user', 'deletion_challenges', '(user_id)'],
    ])('%s covers %s %s', async (name, table, columns) => {
      const [index] = await rows<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`,
        [table, name],
      );

      expect(index?.indexdef).toContain(columns);
    });

    it('idx_registration_challenges_secret_hash covers only outstanding challenges', async () => {
      const [index] = await rows<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_registration_challenges_secret_hash'`,
      );

      expect(index?.indexdef).toContain('WHERE (consumed_at IS NULL)');
    });
  });
});
