import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';

import { ACCESS_COOKIE } from '@/core/app/configure-app';
import { AppException } from '@/core/errors/app.exception';
import { logsIds } from '@/core/logging/id-redaction';
import { classifyDbError } from '@/core/errors/db-errors';

import { AuthCookies } from './auth-cookies';
import { TokenService } from './tokens/token.service';

/** The user a request was authenticated as; set by the route guard, read by RBAC and handlers. */
declare module 'fastify' {
  interface FastifyRequest {
    authUserId?: string;
  }
}

/**
 * Spec 1.2 §1.3.6: the one authentication check every protected route runs first. Gives the
 * verified user id and nothing else: roles come from the server's data, never from the token.
 */
@Injectable()
export class AccessAuthenticator {
  private readonly logger = new Logger('Auth');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tokens: TokenService,
    private readonly cookies: AuthCookies,
  ) {}

  /**
   * The user id, or `401 invalid_session` for a missing, invalid or expired token and for an
   * absent or non-active user (one answer for all). If the user can't be read, `503
   * authorization_unavailable` (spec 1.3), never a 401.
   */
  async authenticate(
    request: FastifyRequest,
    operation?: string,
  ): Promise<string> {
    const checked = this.tokens.verify(
      'access',
      this.cookies.read(request, ACCESS_COOKIE),
    );
    if (!checked.ok) this.refuse(checked.failure);
    const userId = checked.claims.sub;

    let rows: { status: string }[];
    try {
      rows = await this.db.query<{ status: string }[]>(
        `SELECT id, status FROM users WHERE id = $1`,
        [userId],
      );
    } catch (error) {
      // Only an outage is a 503; a bug reaches the error filter as the 500 it is.
      if (classifyDbError(error)?.kind !== 'unavailable') throw error;
      this.logger.error(
        {
          event: 'access_check',
          result: 'unavailable',
          category: 'users',
          error: error instanceof Error ? error.name : 'unknown',
        },
        'access check unavailable: user lookup failed',
      );
      throw new AppException('authorization_unavailable');
    }
    if (rows[0]?.status !== 'active')
      this.refuse('user_inactive', logsIds(operation) ? userId : undefined);

    request.authUserId = userId;
    return userId;
  }

  private refuse(category: string, userId?: string): never {
    this.logger.warn(
      { event: 'access_check', result: 'failure', category, userId },
      'access check failed',
    );
    throw new AppException('invalid_session');
  }
}
