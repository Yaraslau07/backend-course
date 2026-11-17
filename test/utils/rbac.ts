import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';

import { TokenService } from '@/modules/auth/tokens/token.service';
import { RbacBootstrap } from '@/modules/rbac/rbac-bootstrap';

import { createUser } from './auth';

/**
 * RBAC state for e2e suites. app_test is shared and persistent, so suites never assume an empty
 * policy: they make sure the bootstrap ran, then create their own uniquely named roles and users.
 */

/** A direct change to the RBAC tables must bump the version in the same transaction (spec 1.1 §1.3.6). */
export async function bumpPolicy(db: DataSource): Promise<void> {
  await db.query(
    `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1`,
  );
}

export async function policyVersion(db: DataSource): Promise<bigint> {
  const [row] = await db.query<{ version: string }[]>(
    `SELECT version FROM rbac_policy_state WHERE id = 1`,
  );
  return BigInt(row.version);
}

/** Runs the bootstrap with a fresh active admin if the policy is still empty. */
export async function ensureBootstrapped(
  app: NestFastifyApplication,
): Promise<void> {
  const db = app.get(DataSource);
  const [{ count }] = await db.query<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM roles WHERE name = 'admin'`,
  );
  if (count > 0) return;
  const admin = await createUser(app);
  await app.get(RbacBootstrap).run(admin.id);
}

/** Removes every RBAC row (for the bootstrap suite only), as one versioned change. */
export async function wipeRbac(db: DataSource): Promise<void> {
  await db.transaction(async (manager) => {
    await manager.query(`DELETE FROM grant_actions`);
    await manager.query(`DELETE FROM grants`);
    await manager.query(`DELETE FROM user_roles`);
    await manager.query(`DELETE FROM permission_actions`);
    await manager.query(`DELETE FROM permissions`);
    await manager.query(`DELETE FROM roles`);
    await manager.query(
      `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1`,
    );
  });
}

export async function roleId(db: DataSource, name: string): Promise<string> {
  const [row] = await db.query<{ id: string }[]>(
    `SELECT id FROM roles WHERE name = $1`,
    [name],
  );
  if (!row) throw new Error(`role ${name} does not exist`);
  return row.id;
}

/** An access token for a user, signed like a real login (no rate limit, no password check). */
export function accessFor(app: NestFastifyApplication, userId: string): string {
  return app.get(TokenService).issuePair(userId).access;
}

export interface Actor {
  id: string;
  email: string;
  cookies: Record<string, string>;
}

/** A new active user with exactly these roles (by name), and an access cookie. */
export async function actorWithRoles(
  app: NestFastifyApplication,
  roles: string[],
): Promise<Actor> {
  const db = app.get(DataSource);
  const user = await createUser(app);
  for (const name of roles) {
    await db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [user.id, await roleId(db, name)],
    );
  }
  await bumpPolicy(db);
  return {
    id: user.id,
    email: user.email,
    cookies: { access_token: accessFor(app, user.id) },
  };
}

/** A unique, valid role or permission name. */
export const uniqueName = (prefix: string) =>
  `${prefix}-${randomUUID().slice(0, 8)}`;
