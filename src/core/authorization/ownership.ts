/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';

import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

/** Whether the request acts on the caller's own resource (spec 1.4 §1.5: `self` or `foreign`). */
export type Scope = 'self' | 'foreign';

/**
 * Spec 1.3 §1.3.4: the resource and ownership step, after the route's own pair has passed RBAC.
 * Handlers call it; the guard can't, because only the handler knows the target.
 */
@Injectable()
export class Ownership {
  constructor(private readonly rbac: RbacAuthorizer) {}

  /**
   * Before looking the target up: the caller's own id passes; someone else's needs the extra
   * `permission@anyAction` (`users@read_any`, …), or `403 ownership_denied`. So without the right,
   * the answer never depends on whether the target exists.
   */
  selfOr(
    _actorUserId: string,
    _targetUserId: string,
    _permission: string,
    _anyAction: string,
    _operation: string,
  ): Promise<Scope> {
    throw new Error('not implemented');
  }

  /** After loading a resource that has an owner: `403 ownership_denied` unless it is the caller's. */
  assertOwner(
    _actorUserId: string,
    _ownerUserId: string,
    _operation: string,
  ): void {
    throw new Error('not implemented');
  }
}
