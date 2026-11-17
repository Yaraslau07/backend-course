/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { RbacPolicyStore } from './rbac-policy.store';

/** The role every user gets on activation (spec 1.0, 1.1). */
export const DEFAULT_ROLE = 'user';

/**
 * Spec 1.1 §1.3.1: `authorize(userId, permission, action)` for the route guard, and the default
 * role on activation for registration.
 */
@Injectable()
export class RbacAuthorizer {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly store: RbacPolicyStore,
  ) {}

  /** Resolves when allowed; `403 permission_denied`, or `503 authorization_unavailable`. */
  authorize(
    _userId: string,
    _permission: string,
    _action: string,
  ): Promise<void> {
    throw new Error('not implemented');
  }

  /**
   * In the activating transaction: gives the user the `user` role if they don't have it yet.
   * No version bump: user roles are not in the snapshot (D45).
   */
  assignDefaultRole(_manager: EntityManager, _userId: string): Promise<void> {
    throw new Error('not implemented');
  }
}
