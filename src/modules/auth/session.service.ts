import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';

import { TokenService, type TokenPair } from './tokens/token.service';

/**
 * Spec 1.2 §1.3.4–1.3.5. Sessions are not stored: refresh checks the token and the user's current
 * status, then signs a new pair; the used refresh stays valid until its own exp (no rotation
 * tracking, no denylist). Logout only clears cookies, so it needs nothing here.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger('Auth');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tokens: TokenService,
  ) {}

  /**
   * A new pair, or `401 invalid_session`. A database failure propagates to the error filter as
   * `503 service_unavailable` (spec: "503, not 401").
   */
  async refresh(refreshToken: string | undefined): Promise<TokenPair> {
    const checked = this.tokens.verify('refresh', refreshToken);
    if (!checked.ok) this.refuse(checked.failure);
    const userId = checked.claims.sub;

    const rows = await this.db.query<{ status: string }[]>(
      `SELECT id, status FROM users WHERE id = $1`,
      [userId],
    );
    if (rows[0]?.status !== 'active') this.refuse('user_inactive', userId);

    const pair = this.tokens.issuePair(userId);
    this.logger.log(
      { event: 'refresh', result: 'success', userId },
      'session refreshed',
    );
    return pair;
  }

  logout(): void {
    this.logger.log({ event: 'logout', result: 'success' }, 'cookies cleared');
  }

  private refuse(category: string, userId?: string): never {
    this.logger.warn(
      { event: 'refresh', result: 'failure', category, userId },
      'refresh refused',
    );
    throw new AppException('invalid_session');
  }
}
