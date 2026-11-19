import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';

import { RBAC_LOGGED_ERRORS } from './rbac-admin.service';
import { RbacPolicyStore } from './rbac-policy.store';

const ENTITIES: Record<string, string> = {
  roles: 'role',
  permissions: 'permission',
  grants: 'grant',
  users: 'user_roles',
};

/** A framework 400 (a malformed path id from `ParseUUIDPipe`) is a `bad_request` like ours. */
function codeOf(error: unknown): string {
  if (error instanceof AppException) return error.code;
  return error instanceof HttpException && error.getStatus() === 400
    ? 'bad_request'
    : 'error';
}

/**
 * Spec 1.1 §1.5: a rejected administrative operation is logged with the actor, operation, entity
 * type and id, the policy version and the result. `RbacAdminService.change()` logs what it refuses
 * itself (404, 409, a foreign action); this covers what happens before it: a 400 from the path or
 * body validation, and an unavailable database on reads. The guard has already allowed the actor,
 * so the path id may be logged. Bodies and descriptions never are.
 */
@Injectable()
export class RbacAdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Rbac');

  constructor(private readonly policy: RbacPolicyStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          if (
            typeof error === 'object' &&
            error &&
            RBAC_LOGGED_ERRORS.has(error)
          )
            return;
          const request = context.switchToHttp().getRequest<FastifyRequest>();
          const params = request.params as Record<string, string | undefined>;
          const segment = request.url.split('?')[0].split('/')[3] ?? '';
          const unavailable =
            error instanceof AppException
              ? error.code === 'service_unavailable' ||
                error.code === 'authorization_unavailable'
              : classifyDbError(error)?.kind === 'unavailable';
          this.logger.warn(
            {
              event: 'rbac_change',
              actorUserId: request.authUserId,
              operation: context.getHandler().name,
              entityType: ENTITIES[segment] ?? 'unknown',
              entityId: Object.values(params)[0] ?? null,
              version: this.policy.loadedVersion(),
              result: 'failure',
              // Not `code`: the logger redacts `*.code` (see logging.module.ts).
              errorCode: codeOf(error),
              ...(unavailable ? { category: 'dependency' } : {}),
            },
            'RBAC admin request refused',
          );
        },
      }),
    );
  }
}
