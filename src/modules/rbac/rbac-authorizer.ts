import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';

import { RbacPolicyStore } from './rbac-policy.store';
import { DEFAULT_ROLE } from './rbac.types';

/**
 * Spec 1.1 §1.3.1: `authorize(userId, permission, action)` for the route guard, and the default
 * role on activation for registration.
 */
@Injectable()
export class RbacAuthorizer {
  private readonly logger = new Logger('Rbac');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly store: RbacPolicyStore,
  ) {}

  /**
   * Resolves when one of the user's current roles allows the pair; otherwise `403
   * permission_denied`, with nothing about roles or the target in the answer. `503
   * authorization_unavailable` when the policy or the user's roles can't be read. Both outcomes
   * are logged with the actor, operation, pair and policy version (spec 1.3 §1.5).
   */
  async authorize(
    userId: string,
    permission: string,
    action: string,
    operation: string,
  ): Promise<void> {
    if (!(await this.decide(userId, permission, action, operation, true))) {
      throw new AppException('permission_denied');
    }
  }

  /**
   * The same decision without throwing, for a second check inside a handler (the ownership step's
   * `users@read_any`). `503 authorization_unavailable` still throws: unavailability is never a no.
   * It logs nothing: the caller logs the outcome under its own category (`ownership_denied`), so
   * one refusal never shows up as two (D50).
   */
  allows(
    userId: string,
    permission: string,
    action: string,
    operation: string,
  ): Promise<boolean> {
    return this.decide(userId, permission, action, operation, false);
  }

  private async decide(
    userId: string,
    permission: string,
    action: string,
    operation: string,
    log: boolean,
  ): Promise<boolean> {
    // Independent reads, in parallel: the policy version (and a reload if needed) and the roles.
    const roles = this.db.query<{ role_id: string }[]>(
      `SELECT role_id FROM user_roles WHERE user_id = $1`,
      [userId],
    );
    roles.catch(() => undefined); // handled below; keeps a rejection from going unobserved
    const snapshot = await this.store.current();
    let roleIds: string[];
    try {
      roleIds = (await roles).map((row) => row.role_id);
    } catch (error) {
      if (classifyDbError(error)?.kind !== 'unavailable') throw error;
      this.logger.error(
        {
          event: 'rbac_decision',
          result: 'unavailable',
          category: 'users',
          actorUserId: userId,
          operation,
        },
        'user roles unavailable',
      );
      throw new AppException('authorization_unavailable');
    }

    const decision = snapshot.allows(roleIds, permission, action);
    const fields = {
      actorUserId: userId,
      operation,
      permission,
      action,
      version: snapshot.version,
    };
    if (!log) return decision === 'allowed';
    if (decision === 'allowed') {
      this.logger.log(
        { event: 'rbac_decision', result: 'allowed', ...fields },
        'access allowed by RBAC',
      );
      return true;
    }
    this.logger.warn(
      {
        event: 'rbac_decision',
        result: 'denied',
        category: 'permission_denied',
        reason: decision,
        ...fields,
      },
      'access denied by RBAC',
    );
    return false;
  }

  /**
   * In the activating transaction: gives the user the `user` role if they don't have it yet.
   * No version bump: user roles are read per request, not cached in the snapshot (D45). Before the
   * bootstrap there is no `user` role; the bootstrap then gives it to every active user.
   */
  async assignDefaultRole(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const assigned = await manager.query<{ user_id: string }[]>(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = $2
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [userId, DEFAULT_ROLE],
    );
    this.logger.log(
      {
        event: 'default_role',
        userId,
        result: assigned.length === 1 ? 'assigned' : 'unchanged',
      },
      'default role on activation',
    );
  }
}
