import type { CookieSerializeOptions } from '@fastify/cookie';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ACCESS_COOKIE } from '@/core/app/configure-app';
import { ConfigService } from '@/core/config/config.service';

import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  type TokenPair,
} from './tokens/token.service';

export const REFRESH_COOKIE = 'refresh_token';
/** The refresh cookie is sent to the refresh endpoint only (spec 1.2 §1.3.3). */
export const REFRESH_COOKIE_PATH = '/auth/refresh';

type CookieName = typeof ACCESS_COOKIE | typeof REFRESH_COOKIE;

/**
 * The two auth cookies (spec 1.2 §1.3.3): host-only (no `Domain`), `HttpOnly`, `Secure`,
 * `SameSite=Strict` (or `None` for a cross-site frontend, D42), with Max-Age equal to the
 * token's lifetime. Logout sends the same attributes with Max-Age=0, so the browser matches and
 * drops exactly these cookies.
 */
@Injectable()
export class AuthCookies {
  private readonly base: CookieSerializeOptions;

  constructor(config: ConfigService) {
    this.base = {
      httpOnly: true,
      secure: config.get('COOKIE_SECURE'),
      sameSite: config.get('COOKIE_SAME_SITE'),
    };
  }

  set(reply: FastifyReply, pair: TokenPair): void {
    void reply
      .setCookie(ACCESS_COOKIE, pair.access, {
        ...this.base,
        path: '/',
        maxAge: ACCESS_TTL_SECONDS,
      })
      .setCookie(REFRESH_COOKIE, pair.refresh, {
        ...this.base,
        path: REFRESH_COOKIE_PATH,
        maxAge: REFRESH_TTL_SECONDS,
      });
  }

  clear(reply: FastifyReply): void {
    const expired = { ...this.base, maxAge: 0, expires: new Date(0) };
    void reply
      .setCookie(ACCESS_COOKIE, '', { ...expired, path: '/' })
      .setCookie(REFRESH_COOKIE, '', {
        ...expired,
        path: REFRESH_COOKIE_PATH,
      });
  }

  /** From the Cookie header only: never a body, query or other header (spec 1.2 §1.3.4). */
  read(request: FastifyRequest, name: CookieName): string | undefined {
    const value = request.cookies?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
