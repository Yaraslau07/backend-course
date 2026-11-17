/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import type { JwtVerification, TokenUse } from './jwt';

/** Spec 1.2: access lives 15 minutes, refresh 30 days; the cookies' Max-Age matches. */
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenPair {
  access: string;
  refresh: string;
}

@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService) {}

  /** Both tokens, or a `503 service_unavailable` if either can't be signed. */
  issuePair(_userId: string): TokenPair {
    throw new Error('not implemented');
  }

  verify(_use: TokenUse, _token: string | undefined): JwtVerification {
    throw new Error('not implemented');
  }
}
