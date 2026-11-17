import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import type { ErrorCode } from '@/core/errors/error-catalogue';
import { classifyDbError } from '@/core/errors/db-errors';

import type { GrantDto } from './dto/grant.dto';
import type { PermissionDto } from './dto/permission.dto';
import type { RoleDto } from './dto/role.dto';
import { RBAC_MANAGE } from './rbac.types';

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionView extends RoleView {
  actions: string[];
}

export interface GrantView {
  id: string;
  roleId: string;
  permissionId: string;
  allActions: boolean;
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserRolesView {
  userId: string;
  roleIds: string[];
}

type EntityType = 'role' | 'permission' | 'grant' | 'user_roles';
type Operation = 'create' | 'replace' | 'delete';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}
interface PermissionRow extends RoleRow {
  actions: string[];
}
interface GrantRow {
  id: string;
  role_id: string;
  permission_id: string;
  all_actions: boolean;
  actions: string[];
  created_at: Date;
  updated_at: Date;
}

/** Unique constraints → the 409 a client can act on (spec 1.1 §1.3.2 step 4). */
const UNIQUE_CODES: Record<string, ErrorCode> = {
  uq_roles_name: 'name_taken',
  uq_permissions_name: 'name_taken',
  uq_grants_role_permission: 'grant_exists',
};

const PERMISSION_SELECT = `
  SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
         coalesce(array_agg(pa.action ORDER BY pa.action) FILTER (WHERE pa.action IS NOT NULL), '{}') AS actions
    FROM permissions p LEFT JOIN permission_actions pa ON pa.permission_id = p.id`;
const GRANT_SELECT = `
  SELECT g.id, g.role_id, g.permission_id, g.all_actions, g.created_at, g.updated_at,
         coalesce(array_agg(ga.action ORDER BY ga.action) FILTER (WHERE ga.action IS NOT NULL), '{}') AS actions
    FROM grants g LEFT JOIN grant_actions ga ON ga.grant_id = g.id`;

/**
 * "Is there still an active user who may do rbac@manage?", on the state the transaction is about to
 * commit. An all-actions grant counts only while the permission still has `manage`.
 */
const HOLDER_REMAINS = `
  SELECT EXISTS (
    SELECT 1
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN grants g ON g.role_id = ur.role_id
      JOIN permissions p ON p.id = g.permission_id AND p.name = $1
      JOIN permission_actions pa ON pa.permission_id = p.id AND pa.action = $2
     WHERE u.status = 'active'
       AND (g.all_actions OR EXISTS (
             SELECT 1 FROM grant_actions ga WHERE ga.grant_id = g.id AND ga.action = $2))
  ) AS ok`;

const iso = (value: Date) => value.toISOString();

const roleView = (row: RoleRow): RoleView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const permissionView = (row: PermissionRow): PermissionView => ({
  ...roleView(row),
  actions: row.actions,
});

const grantView = (row: GrantRow): GrantView => ({
  id: row.id,
  roleId: row.role_id,
  permissionId: row.permission_id,
  allActions: row.all_actions,
  actions: row.all_actions ? [] : row.actions,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/**
 * Spec 1.1 §1.3.2–1.3.5. Every change is one transaction that locks `rbac_policy_state` first (the
 * lock order), makes the change, checks that an active `rbac@manage` holder remains, and bumps the
 * version; any refusal rolls all of it back. The caller has already passed `rbac@manage`, so a 404
 * here never leaks anything to someone without the right.
 */
@Injectable()
export class RbacAdminService {
  private readonly logger = new Logger('Rbac');

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /* ---------- roles (§1.3.2) ---------- */

  async listRoles(): Promise<RoleView[]> {
    const rows = await this.db.query<RoleRow[]>(
      `SELECT id, name, description, created_at, updated_at FROM roles ORDER BY name`,
    );
    return rows.map(roleView);
  }

  createRole(actor: string, dto: RoleDto): Promise<RoleView> {
    return this.change(actor, 'create', 'role', null, async (manager) => {
      const [row] = await manager.query<RoleRow[]>(
        `INSERT INTO roles (name, description) VALUES ($1, $2)
         RETURNING id, name, description, created_at, updated_at`,
        [dto.name, dto.description ?? null],
      );
      return { id: row.id, value: roleView(row) };
    });
  }

  replaceRole(actor: string, id: string, dto: RoleDto): Promise<RoleView> {
    return this.change(actor, 'replace', 'role', id, async (manager) => {
      const [[row]] = await manager.query<[RoleRow[], number]>(
        `UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1
         RETURNING id, name, description, created_at, updated_at`,
        [id, dto.name, dto.description ?? null],
      );
      if (!row) throw new AppException('not_found');
      return { id, value: roleView(row) };
    });
  }

  /** A role with grants or users can't go: the foreign keys refuse it, which becomes 409. */
  deleteRole(actor: string, id: string): Promise<void> {
    return this.change(actor, 'delete', 'role', id, async (manager) => {
      const [, affected] = await manager.query<[unknown, number]>(
        `DELETE FROM roles WHERE id = $1`,
        [id],
      );
      if (affected === 0) throw new AppException('not_found');
      return { id, value: undefined };
    });
  }

  /* ---------- permissions (§1.3.3) ---------- */

  async listPermissions(): Promise<PermissionView[]> {
    const rows = await this.db.query<PermissionRow[]>(
      `${PERMISSION_SELECT} GROUP BY p.id ORDER BY p.name`,
    );
    return rows.map(permissionView);
  }

  createPermission(actor: string, dto: PermissionDto): Promise<PermissionView> {
    return this.change(actor, 'create', 'permission', null, async (manager) => {
      const [row] = await manager.query<{ id: string }[]>(
        `INSERT INTO permissions (name, description) VALUES ($1, $2) RETURNING id`,
        [dto.name, dto.description ?? null],
      );
      await this.addActions(manager, row.id, dto.actions);
      return { id: row.id, value: await this.permission(manager, row.id) };
    });
  }

  /**
   * Replaces name, description and the whole action set. Removing an action that a grant lists
   * explicitly fails on `fk_grant_actions_permission_action` (409); all-actions grants just cover
   * what remains, and new actions join them.
   */
  replacePermission(
    actor: string,
    id: string,
    dto: PermissionDto,
  ): Promise<PermissionView> {
    return this.change(actor, 'replace', 'permission', id, async (manager) => {
      const [, affected] = await manager.query<[unknown, number]>(
        `UPDATE permissions SET name = $2, description = $3, updated_at = now() WHERE id = $1`,
        [id, dto.name, dto.description ?? null],
      );
      if (affected === 0) throw new AppException('not_found');
      await manager.query(
        `DELETE FROM permission_actions WHERE permission_id = $1 AND NOT (action = ANY($2::text[]))`,
        [id, dto.actions],
      );
      await this.addActions(manager, id, dto.actions);
      return { id, value: await this.permission(manager, id) };
    });
  }

  deletePermission(actor: string, id: string): Promise<void> {
    return this.change(actor, 'delete', 'permission', id, async (manager) => {
      const [, affected] = await manager.query<[unknown, number]>(
        `DELETE FROM permissions WHERE id = $1`,
        [id],
      );
      if (affected === 0) throw new AppException('not_found');
      return { id, value: undefined };
    });
  }

  /* ---------- grants (§1.3.4) ---------- */

  async listGrants(): Promise<GrantView[]> {
    const rows = await this.db.query<GrantRow[]>(
      `${GRANT_SELECT} GROUP BY g.id ORDER BY g.created_at, g.id`,
    );
    return rows.map(grantView);
  }

  createGrant(actor: string, dto: GrantDto): Promise<GrantView> {
    return this.change(actor, 'create', 'grant', null, async (manager) => {
      const actions = await this.checkGrantTargets(manager, dto);
      const [row] = await manager.query<{ id: string }[]>(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, $3) RETURNING id`,
        [dto.roleId, dto.permissionId, actions.length === 0],
      );
      await this.listActions(manager, row.id, dto.permissionId, actions);
      return { id: row.id, value: await this.grant(manager, row.id) };
    });
  }

  replaceGrant(actor: string, id: string, dto: GrantDto): Promise<GrantView> {
    return this.change(actor, 'replace', 'grant', id, async (manager) => {
      const [existing] = await manager.query<{ id: string }[]>(
        `SELECT id FROM grants WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!existing) throw new AppException('not_found');
      const actions = await this.checkGrantTargets(manager, dto);
      // The listed actions go first: their composite key pins them to the old permission.
      await manager.query(`DELETE FROM grant_actions WHERE grant_id = $1`, [
        id,
      ]);
      await manager.query(
        `UPDATE grants SET role_id = $2, permission_id = $3, all_actions = $4, updated_at = now()
          WHERE id = $1`,
        [id, dto.roleId, dto.permissionId, actions.length === 0],
      );
      await this.listActions(manager, id, dto.permissionId, actions);
      return { id, value: await this.grant(manager, id) };
    });
  }

  deleteGrant(actor: string, id: string): Promise<void> {
    return this.change(actor, 'delete', 'grant', id, async (manager) => {
      const [, affected] = await manager.query<[unknown, number]>(
        `DELETE FROM grants WHERE id = $1`,
        [id],
      );
      if (affected === 0) throw new AppException('not_found');
      return { id, value: undefined };
    });
  }

  /* ---------- user roles (§1.3.5) ---------- */

  async getUserRoles(userId: string): Promise<UserRolesView> {
    const [user] = await this.db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new AppException('not_found');
    return { userId, roleIds: await this.rolesOf(this.db.manager, userId) };
  }

  replaceUserRoles(
    actor: string,
    userId: string,
    roleIds: string[],
  ): Promise<UserRolesView> {
    return this.change(
      actor,
      'replace',
      'user_roles',
      userId,
      async (manager) => {
        // Lock order: policy state (in change()) → user.
        const [user] = await manager.query<{ id: string }[]>(
          `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
          [userId],
        );
        if (!user) throw new AppException('not_found');
        const [{ count }] = await manager.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM roles WHERE id = ANY($1::uuid[])`,
          [roleIds],
        );
        if (count !== roleIds.length) throw new AppException('not_found');
        await manager.query(`DELETE FROM user_roles WHERE user_id = $1`, [
          userId,
        ]);
        await manager.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[])`,
          [userId, roleIds],
        );
        return {
          id: userId,
          value: { userId, roleIds: await this.rolesOf(manager, userId) },
        };
      },
    );
  }

  /* ---------- internals ---------- */

  /**
   * The shape of every change (spec 1.1 §1.3.2–1.3.5, §1.3.6 step 2): policy lock → work →
   * holder check → version + 1, all in one transaction. Logs the outcome by actor, entity and
   * version; never the description or the body.
   */
  private async change<T>(
    actor: string,
    operation: Operation,
    entityType: EntityType,
    entityId: string | null,
    work: (manager: EntityManager) => Promise<{ id: string; value: T }>,
  ): Promise<T> {
    try {
      const done = await this.db.transaction(async (manager) => {
        await manager.query(
          `SELECT id FROM rbac_policy_state WHERE id = 1 FOR UPDATE`,
        );
        const result = await work(manager);
        const [{ ok }] = await manager.query<{ ok: boolean }[]>(
          HOLDER_REMAINS,
          [RBAC_MANAGE.permission, RBAC_MANAGE.action],
        );
        if (!ok) throw new AppException('last_rbac_manager');
        const [[state]] = await manager.query<[{ version: string }[], number]>(
          `UPDATE rbac_policy_state SET version = version + 1, updated_at = now()
            WHERE id = 1 RETURNING version`,
        );
        return { ...result, version: state.version };
      });
      this.logger.log(
        {
          event: 'rbac_change',
          actorUserId: actor,
          operation,
          entityType,
          entityId: done.id,
          version: done.version,
          result: 'success',
        },
        'RBAC policy changed',
      );
      return done.value;
    } catch (error) {
      const refused = this.asRefusal(error);
      this.logger.warn(
        {
          event: 'rbac_change',
          actorUserId: actor,
          operation,
          entityType,
          entityId,
          result: 'failure',
          code: refused instanceof AppException ? refused.code : 'error',
        },
        'RBAC change refused',
      );
      throw refused;
    }
  }

  /** Constraint violations as the spec's 409s; anything else unchanged. */
  private asRefusal(error: unknown): unknown {
    const db = classifyDbError(error);
    if (db?.kind === 'unique_violation') {
      return new AppException(
        (db.constraint && UNIQUE_CODES[db.constraint]) || 'conflict',
      );
    }
    // 23503: a role, permission or action that is still referenced (no cascades on purpose).
    if (db?.kind === 'other' && db.dbCode === '23503') {
      return new AppException('resource_in_use');
    }
    return error;
  }

  /** Role and permission exist (404), and every listed action belongs to the permission (400). */
  private async checkGrantTargets(
    manager: EntityManager,
    dto: GrantDto,
  ): Promise<string[]> {
    const [role] = await manager.query<{ id: string }[]>(
      `SELECT id FROM roles WHERE id = $1`,
      [dto.roleId],
    );
    const [permission] = await manager.query<{ actions: string[] }[]>(
      `SELECT array(SELECT action FROM permission_actions WHERE permission_id = p.id) AS actions
         FROM permissions p WHERE p.id = $1`,
      [dto.permissionId],
    );
    if (!role || !permission) throw new AppException('not_found');
    const actions = dto.actions ?? [];
    if (actions.some((action) => !permission.actions.includes(action))) {
      throw new AppException('validation_failed', {
        errors: [{ field: 'actions', rules: ['actionOfPermission'] }],
      });
    }
    return actions;
  }

  private async addActions(
    manager: EntityManager,
    permissionId: string,
    actions: string[],
  ): Promise<void> {
    await manager.query(
      `INSERT INTO permission_actions (permission_id, action)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [permissionId, actions],
    );
  }

  private async listActions(
    manager: EntityManager,
    grantId: string,
    permissionId: string,
    actions: string[],
  ): Promise<void> {
    if (actions.length === 0) return;
    await manager.query(
      `INSERT INTO grant_actions (grant_id, permission_id, action)
       SELECT $1, $2, unnest($3::text[])`,
      [grantId, permissionId, actions],
    );
  }

  private async permission(
    manager: EntityManager,
    id: string,
  ): Promise<PermissionView> {
    const [row] = await manager.query<PermissionRow[]>(
      `${PERMISSION_SELECT} WHERE p.id = $1 GROUP BY p.id`,
      [id],
    );
    return permissionView(row);
  }

  private async grant(manager: EntityManager, id: string): Promise<GrantView> {
    const [row] = await manager.query<GrantRow[]>(
      `${GRANT_SELECT} WHERE g.id = $1 GROUP BY g.id`,
      [id],
    );
    return grantView(row);
  }

  private async rolesOf(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    const rows = await manager.query<{ role_id: string }[]>(
      `SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id`,
      [userId],
    );
    return rows.map((row) => row.role_id);
  }
}
