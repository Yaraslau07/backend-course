import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { type JwtVerification, signJwt, type TokenUse, verifyJwt } from './jwt';

/** Spec 1.2: access lives 15 minutes, refresh 30 days; the cookies' Max-Age matches. */
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenPair {
  access: string;
  refresh: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Stateless HS256 tokens (spec 1.2 §1.3.3). Access and refresh have separate keys, so one kind
 * can't be passed off as the other even before `token_use` is read. Nothing is stored.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger('Auth');

  constructor(private readonly config: ConfigService) {}

  /**
   * Both tokens from one `iat`, or `503 service_unavailable` if either can't be signed: the caller
   * sets cookies only after this returns, so a failure never sends half a pair.
   */
  issuePair(userId: string): TokenPair {
    const iat = nowSeconds();
    const base = {
      sub: userId,
      iss: this.config.get('JWT_ISSUER'),
      aud: this.config.get('JWT_AUDIENCE'),
      iat,
    };
    try {
      return {
        access: signJwt(
          { ...base, exp: iat + ACCESS_TTL_SECONDS, token_use: 'access' },
          this.config.get('JWT_ACCESS_SECRET'),
        ),
        refresh: signJwt(
          { ...base, exp: iat + REFRESH_TTL_SECONDS, token_use: 'refresh' },
          this.config.get('JWT_REFRESH_SECRET'),
        ),
      };
    } catch (error) {
      this.logger.error(
        {
          category: 'token_signing',
          userId,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'token signing unavailable',
      );
      throw new AppException('service_unavailable');
    }
  }

  verify(use: TokenUse, token: string | undefined): JwtVerification {
    return verifyJwt(
      token,
      this.config.get(
        use === 'access' ? 'JWT_ACCESS_SECRET' : 'JWT_REFRESH_SECRET',
      ),
      {
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
        use,
        now: nowSeconds(),
      },
    );
  }
}
