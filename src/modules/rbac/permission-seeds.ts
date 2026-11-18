import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ADMIN_ROLE, DEFAULT_ROLE } from './rbac.types';

/**
 * A module's own permission, created on first install (spec 2.0 §1.1): its actions, the subset the
 * `user` role gets, and all of them for `admin` if that role exists.
 */
export interface PermissionSeed {
  permission: string;
  actions: readonly string[];
  defaultRoleActions: readonly string[];
}

export type SeedResult = 'created' | 'present' | 'no_default_role';

/**
 * Seeds that modules register in `onModuleInit`. `RbacBootstrap.run()` applies them after its own
 * step, on every start, so a module added to an already configured installation still gets its
 * permission. A seed only acts while its permission doesn't exist: restarting never restores a
 * grant someone removed. Without a `user` role it creates nothing and waits for a later start,
 * since a permission created then would never reach that role (D66).
 */
@Injectable()
export class RbacPermissionSeeds {
  private readonly logger = new Logger('Rbac');
  private readonly seeds: PermissionSeed[] = [];

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  register(seed: PermissionSeed): void {
    if (this.seeds.some((s) => s.permission === seed.permission))
      throw new Error(
        `Permission seed "${seed.permission}" is already registered`,
      );
    if (!seed.defaultRoleActions.every((a) => seed.actions.includes(a)))
      throw new Error(
        `Seed "${seed.permission}" grants an action it doesn't declare`,
      );
    this.seeds.push(seed);
  }

  async applyAll(): Promise<Record<string, SeedResult>> {
    const results: Record<string, SeedResult> = {};
    for (const seed of this.seeds) {
      results[seed.permission] = await this.db.transaction((manager) =>
        this.apply(manager, seed),
      );
      this.logger.log(
        {
          event: 'rbac_seed',
          permission: seed.permission,
          result: results[seed.permission],
        },
        'permission seed applied',
      );
    }
    return results;
  }

  private async apply(
    manager: EntityManager,
    seed: PermissionSeed,
  ): Promise<SeedResult> {
    await manager.query(
      `SELECT id FROM rbac_policy_state WHERE id = 1 FOR UPDATE`,
    );
    const [existing] = await manager.query<{ id: string }[]>(
      `SELECT id FROM permissions WHERE name = $1`,
      [seed.permission],
    );
    if (existing) return 'present';
    const roles = await manager.query<{ id: string; name: string }[]>(
      `SELECT id, name FROM roles WHERE name = ANY($1::text[])`,
      [[DEFAULT_ROLE, ADMIN_ROLE]],
    );
    const userRole = roles.find((r) => r.name === DEFAULT_ROLE);
    if (!userRole) return 'no_default_role';
    const adminRole = roles.find((r) => r.name === ADMIN_ROLE);

    const [permission] = await manager.query<{ id: string }[]>(
      `INSERT INTO permissions (name) VALUES ($1) RETURNING id`,
      [seed.permission],
    );
    await manager.query(
      `INSERT INTO permission_actions (permission_id, action) SELECT $1, unnest($2::text[])`,
      [permission.id, seed.actions],
    );
    const [grant] = await manager.query<{ id: string }[]>(
      `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, false) RETURNING id`,
      [userRole.id, permission.id],
    );
    await manager.query(
      `INSERT INTO grant_actions (grant_id, permission_id, action) SELECT $1, $2, unnest($3::text[])`,
      [grant.id, permission.id, seed.defaultRoleActions],
    );
    if (adminRole)
      await manager.query(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, true)`,
        [adminRole.id, permission.id],
      );
    await manager.query(
      `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1`,
    );
    return 'created';
  }
}
