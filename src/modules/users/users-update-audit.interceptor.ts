import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { AppException } from '@/core/errors/app.exception';

/** Completes the operation audit for validation/refusals before a service transaction starts. */
@Injectable()
export class UsersUpdateAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('UsersUpdateRequests');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const body: unknown = request.body;
    const fields = ['displayName', 'email', 'status'].filter(
      (field) =>
        typeof body === 'object' && body !== null && Object.hasOwn(body, field),
    );
    const common = {
      event: 'user_update_request',
      requestId: request.id,
      actorUserId: request.authUserId,
      operation: context.getHandler().name,
      fields,
    };
    return next.handle().pipe(
      tap({
        next: () => {
          const params = request.params as { userId: string };
          this.logger.log(
            { ...common, targetUserId: params.userId, result: 'success' },
            'user change request completed',
          );
        },
        error: (error: unknown) => {
          // A rejection may precede ownership permission. The service logs the target only when
          // allowed; this boundary never discloses it on failure or logs arbitrary body keys/values.
          this.logger.warn(
            {
              ...common,
              result: 'failure',
              category:
                error instanceof AppException ? error.code : 'dependency',
            },
            'user change request refused',
          );
        },
      }),
    );
  }
}
