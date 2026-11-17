import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LightMyRequestResponse } from 'fastify';
import { DataSource } from 'typeorm';

import { PasswordHasher } from '@/modules/auth/password-hasher';

/** Helpers for the login and session e2e suites. */

export const PASSWORD = 'correct horse 1';

/** A client IP of its own per test, so a rate limit only bites where a test means it to. */
export const ip = () =>
  `198.19.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  headers: LightMyRequestResponse['headers'];
  cookies: Map<string, ParsedCookie>;
}

export interface ParsedCookie {
  value: string;
  attributes: Map<string, string>;
  raw: string;
}

/** Every Set-Cookie of a response, by name, with lowercase attribute names. */
export function parseSetCookies(
  header: string | string[] | undefined,
): Map<string, ParsedCookie> {
  const list =
    header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookies = new Map<string, ParsedCookie>();
  for (const raw of list) {
    const [pair, ...rest] = raw.split(';').map((part) => part.trim());
    const eq = pair.indexOf('=');
    const attributes = new Map<string, string>();
    for (const attribute of rest) {
      const at = attribute.indexOf('=');
      attributes.set(
        (at < 0 ? attribute : attribute.slice(0, at)).toLowerCase(),
        at < 0 ? '' : attribute.slice(at + 1),
      );
    }
    cookies.set(pair.slice(0, eq), {
      value: pair.slice(eq + 1),
      attributes,
      raw,
    });
  }
  return cookies;
}

export async function send(
  app: NestFastifyApplication,
  url: string,
  options: {
    body?: unknown;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    remoteAddress?: string;
    method?: 'POST' | 'GET';
  } = {},
): Promise<Reply> {
  const res = await app.inject({
    method: options.method ?? 'POST',
    url,
    ...(options.body === undefined
      ? {}
      : { payload: options.body as Record<string, unknown> }),
    cookies: options.cookies,
    headers: options.headers,
    remoteAddress: options.remoteAddress ?? ip(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body || '{}') as Record<string, unknown>;
  } catch {
    body = {};
  }
  return {
    status: res.statusCode,
    body,
    raw: res.body,
    headers: res.headers,
    cookies: parseSetCookies(res.headers['set-cookie']),
  };
}

/** A user straight in the database (registration has its own rate limit and suite). */
export async function createUser(
  app: NestFastifyApplication,
  options: { email?: string; password?: string; status?: string } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = options.email ?? `login-${randomUUID()}@example.com`;
  const password = options.password ?? PASSWORD;
  const hash = await app.get(PasswordHasher).hash(password);
  const [row] = await app
    .get(DataSource)
    .query<
      { id: string }[]
    >(`INSERT INTO users (email, password_hash, status) VALUES ($1, $2, $3) RETURNING id`, [email, hash, options.status ?? 'active']);
  return { id: row.id, email, password };
}

/** Any status, `deleted` included (its CHECK wants the personal fields cleared). */
export async function setStatus(
  app: NestFastifyApplication,
  userId: string,
  status: string,
): Promise<void> {
  await app
    .get(DataSource)
    .query(
      status === 'deleted'
        ? `UPDATE users SET status = 'deleted', password_hash = NULL, display_name = NULL, photo_key = NULL WHERE id = $1`
        : `UPDATE users SET status = $2 WHERE id = $1`,
      status === 'deleted' ? [userId] : [userId, status],
    );
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >,
  };
}

export const codeFrom = (text: string) => /\b(\d{6})\b/.exec(text)?.[1] ?? '';

/** The `token` in the magic link's fragment. */
export const tokenFrom = (text: string) =>
  new URLSearchParams(
    new URL(/https?:\/\/\S+/.exec(text)?.[0] ?? 'http://x').hash.slice(1),
  ).get('token') ?? '';

/** Moves the user's login challenges back in time, as if `seconds` had passed since the mail. */
export async function ageLoginChallenges(
  app: NestFastifyApplication,
  userId: string,
  seconds: number,
): Promise<void> {
  await app
    .get(DataSource)
    .query(
      `UPDATE login_challenges SET last_sent_at = last_sent_at - make_interval(secs => $2) WHERE user_id = $1`,
      [userId, seconds],
    );
}

export async function loginChallenges(
  app: NestFastifyApplication,
  userId: string,
): Promise<
  {
    id: string;
    method: string;
    attempts: number;
    consumed_reason: string | null;
  }[]
> {
  return app
    .get(DataSource)
    .query(
      `SELECT id, method, attempts, consumed_reason FROM login_challenges WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
}
