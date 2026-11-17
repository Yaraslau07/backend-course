import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { ADMIN_ROLE, DEFAULT_ROLE } from './rbac.types';

export type BootstrapResult =
  | 'bootstrapped'
  | 'not_empty'
  | 'no_admin_configured'
  | 'admin_not_active';

/** Spec 1.1 §1.1: what the bootstrap creates. */
const USERS_ACTIONS = [
  'read',
  'read_any',
  'update',
  'update_any',
  'delete',
  'delete_any',
  'list',
];
const USER_ROLE_ACTIONS = ['read', 'update', 'delete'];

/**
 * Spec 1.1 §1.1: the one-time setup of an empty RBAC configuration. Runs at startup; there is no
 * endpoint. It holds the policy lock, so two instances starting together bootstrap once. Without
 * an active admin it creates nothing and runs again at the next start (D45): a policy with no
 * `rbac@manage` holder could never be changed through the API.
 */
@Injectable()
export class RbacBootstrap {
  private readonly logger = new Logger('Rbac');

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async run(adminUserId: string | undefined): Promise<BootstrapResult> {
    const result = await this.db.transaction(async (manager) => {
      await manager.query(
        `SELECT id FROM rbac_policy_state WHERE id = 1 FOR UPDATE`,
      );
      const [{ empty }] = await manager.query<{ empty: boolean }[]>(
        `SELECT NOT EXISTS (SELECT 1 FROM roles) AND NOT EXISTS (SELECT 1 FROM permissions) AS empty`,
      );
      if (!empty) return { outcome: 'not_empty' as const };
      if (!adminUserId) return { outcome: 'no_admin_configured' as const };

      const [admin] = await manager.query<{ status: string }[]>(
        `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
        [adminUserId],
      );
      if (admin?.status !== 'active') {
        return { outcome: 'admin_not_active' as const };
      }
      return {
        outcome: 'bootstrapped' as const,
        ...(await this.seed(manager, adminUserId)),
      };
    });

    if (result.outcome === 'bootstrapped') {
      this.logger.log(
        {
          event: 'rbac_bootstrap',
          result: result.outcome,
          adminUserId,
          defaultRoleAssigned: result.assigned,
          version: result.version,
        },
        'RBAC bootstrapped',
      );
    } else {
      const log = result.outcome === 'not_empty' ? 'log' : 'warn';
      this.logger[log](
        { event: 'rbac_bootstrap', result: result.outcome },
        result.outcome === 'not_empty'
          ? 'RBAC already configured; bootstrap skipped'
          : 'RBAC is empty and RBAC_BOOTSTRAP_ADMIN_USER_ID is not an active user; bootstrap skipped until the next start',
      );
    }
    return result.outcome;
  }

  private async seed(
    manager: EntityManager,
    adminUserId: string,
  ): Promise<{ assigned: number; version: string }> {
    const permission = async (name: string, actions: string[]) => {
      const [row] = await manager.query<{ id: string }[]>(
        `INSERT INTO permissions (name) VALUES ($1) RETURNING id`,
        [name],
      );
      await manager.query(
        `INSERT INTO permission_actions (permission_id, action) SELECT $1, unnest($2::text[])`,
        [row.id, actions],
      );
      return row.id;
    };
    const role = async (name: string) =>
      (
        await manager.query<{ id: string }[]>(
          `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
          [name],
        )
      )[0].id;
    const grant = async (
      roleId: string,
      permissionId: string,
      actions: string[] | 'all',
    ) => {
      const [row] = await manager.query<{ id: string }[]>(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, $3) RETURNING id`,
        [roleId, permissionId, actions === 'all'],
      );
      if (actions !== 'all') {
        await manager.query(
          `INSERT INTO grant_actions (grant_id, permission_id, action) SELECT $1, $2, unnest($3::text[])`,
          [row.id, permissionId, actions],
        );
      }
    };

    const rbac = await permission('rbac', ['manage']);
    const users = await permission('users', USERS_ACTIONS);
    const userRole = await role(DEFAULT_ROLE);
    const adminRole = await role(ADMIN_ROLE);
    await grant(userRole, users, USER_ROLE_ACTIONS);
    await grant(adminRole, rbac, ['manage']);
    await grant(adminRole, users, 'all');

    await manager.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [adminUserId, adminRole],
    );
    // Every active user without a role gets `user`; pending users get it when they confirm.
    const assigned = await manager.query<{ user_id: string }[]>(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, $1 FROM users u
        WHERE u.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)
       RETURNING user_id`,
      [userRole],
    );
    const [[state]] = await manager.query<[{ version: string }[], number]>(
      `UPDATE rbac_policy_state SET version = version + 1, updated_at = now() WHERE id = 1 RETURNING version`,
    );
    return { assigned: assigned.length, version: state.version };
  }
}
