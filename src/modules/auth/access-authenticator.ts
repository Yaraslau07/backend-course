/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';

import { AuthCookies } from './auth-cookies';
import { TokenService } from './tokens/token.service';

/**
 * Spec 1.2 §1.3.6: the one authentication check every protected route runs first. Gives the
 * verified user id and nothing else (no roles from the token).
 */
@Injectable()
export class AccessAuthenticator {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tokens: TokenService,
    private readonly cookies: AuthCookies,
  ) {}

  /** The user id, or `401 invalid_session`; `503 authorization_unavailable` if the DB is down. */
  authenticate(_request: FastifyRequest): Promise<string> {
    throw new Error('not implemented');
  }
}
