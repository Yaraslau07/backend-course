import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '@/core/errors/app.exception';
import { logsIds } from '@/core/logging/id-redaction';
import { RbacAuthorizer } from '@/modules/rbac/rbac-authorizer';

/** Whether the request acts on the caller's own resource (spec 1.4 §1.5: `self` or `foreign`). */
export type Scope = 'self' | 'foreign';

/** The same uuid, whatever its case (ParseUUIDPipe accepts uppercase; tokens carry lowercase). */
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Spec 1.3 §1.3.4: the resource and ownership step, after the route's own pair has passed RBAC.
 * Handlers call it; the guard can't, because only the handler knows the target.
 */
@Injectable()
export class Ownership {
  private readonly logger = new Logger('Authorization');

  constructor(private readonly rbac: RbacAuthorizer) {}

  /**
   * Before looking the target up: the caller's own id passes; someone else's needs the extra
   * `permission@anyAction` (`users@read_any`, …), or `403 ownership_denied`. So without the right,
   * the answer never depends on whether the target exists, and the target id isn't logged.
   */
  async selfOr(
    actorUserId: string,
    targetUserId: string,
    permission: string,
    anyAction: string,
    operation: string,
  ): Promise<Scope> {
    // Ids from the token are lowercase; a path id may arrive in uppercase and is the same uuid.
    if (sameId(actorUserId, targetUserId)) return 'self';
    if (await this.rbac.allows(actorUserId, permission, anyAction, operation)) {
      return 'foreign';
    }
    this.logger.warn(
      {
        event: 'ownership',
        result: 'denied',
        category: 'ownership_denied',
        ...(logsIds(operation) ? { actorUserId } : {}),
        operation,
        permission,
        action: anyAction,
      },
      'foreign resource refused',
    );
    throw new AppException('ownership_denied');
  }

  /** After loading a resource that has an owner: `403 ownership_denied` unless it is the caller's. */
  assertOwner(
    actorUserId: string,
    ownerUserId: string,
    operation: string,
  ): void {
    if (sameId(actorUserId, ownerUserId)) return;
    this.logger.warn(
      {
        event: 'ownership',
        result: 'denied',
        category: 'ownership_denied',
        ...(logsIds(operation) ? { actorUserId } : {}),
        operation,
      },
      'resource of another user refused',
    );
    throw new AppException('ownership_denied');
  }
}
