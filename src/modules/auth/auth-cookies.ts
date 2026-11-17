/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ACCESS_COOKIE } from '@/core/app/configure-app';
import { ConfigService } from '@/core/config/config.service';

import type { TokenPair } from './tokens/token.service';

export const REFRESH_COOKIE = 'refresh_token';
/** The refresh cookie is sent to the refresh endpoint only (spec 1.2 §1.3.3). */
export const REFRESH_COOKIE_PATH = '/auth/refresh';

@Injectable()
export class AuthCookies {
  constructor(private readonly config: ConfigService) {}

  set(_reply: FastifyReply, _pair: TokenPair): void {
    throw new Error('not implemented');
  }

  clear(_reply: FastifyReply): void {
    throw new Error('not implemented');
  }

  read(
    _request: FastifyRequest,
    _name: typeof ACCESS_COOKIE | typeof REFRESH_COOKIE,
  ): string | undefined {
    throw new Error('not implemented');
  }
}
