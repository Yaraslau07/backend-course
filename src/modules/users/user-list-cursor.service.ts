import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { decodeKey } from '@/core/config/config.validation';
import { AppException } from '@/core/errors/app.exception';

import type { ProfileRow } from './safe-profile';
import type { UserListQuery } from './user-list-query';

export interface ListCursor {
  v: 1;
  kid: string;
  sort: 'createdAt' | 'id';
  order: 'asc' | 'desc';
  snapshotAt: string;
  lastSortValue: string;
  lastTieBreaker: string;
  queryTag: string;
  issuedAt: string;
  expiresAt: string;
}

const TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function bytes(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value) invalid();
  return result;
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function invalid(): never {
  throw new AppException('invalid_cursor');
}

@Injectable()
export class UserListCursor {
  constructor(private readonly config: ConfigService) {}

  encode(
    query: UserListQuery,
    last: Pick<ProfileRow, 'id' | 'created_at'>,
    boundary: string | ListCursor,
  ): string {
    const kid = this.config.get('USER_LIST_CURSOR_ACTIVE_KEY_ID');
    const key = this.key(kid);
    if (!key) throw new AppException('service_unavailable');
    const issuedAt =
      typeof boundary === 'string'
        ? new Date().toISOString()
        : boundary.issuedAt;
    const payload: ListCursor = {
      v: 1,
      kid,
      sort: query.sort,
      order: query.order,
      snapshotAt: typeof boundary === 'string' ? boundary : boundary.snapshotAt,
      lastSortValue:
        query.sort === 'id' ? last.id : last.created_at.toISOString(),
      lastTieBreaker:
        query.sort === 'id' ? last.created_at.toISOString() : last.id,
      queryTag: this.queryTag(query, key),
      issuedAt,
      expiresAt:
        typeof boundary === 'string'
          ? new Date(Date.parse(issuedAt) + TTL_MS).toISOString()
          : boundary.expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${this.hmac(key, 'users-list-cursor', encoded).toString('base64url')}`;
  }

  decode(token: string, query: UserListQuery): ListCursor {
    if (token.length > 8192) invalid();
    const parts = token.split('.');
    if (parts.length !== 2) invalid();
    const decoded = bytes(parts[0]);
    const signature = bytes(parts[1]);
    let value: unknown;
    try {
      value = JSON.parse(decoded.toString('utf8'));
    } catch {
      invalid();
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      invalid();
    const p = value as Record<string, unknown>;
    if (
      Object.keys(p).sort().join(',') !==
      'expiresAt,issuedAt,kid,lastSortValue,lastTieBreaker,order,queryTag,snapshotAt,sort,v'
    )
      invalid();
    if (
      p.v !== 1 ||
      typeof p.kid !== 'string' ||
      p.sort !== query.sort ||
      p.order !== query.order
    )
      invalid();
    const key = this.key(p.kid);
    if (
      !key ||
      !equal(signature, this.hmac(key, 'users-list-cursor', parts[0]))
    )
      invalid();
    if (
      !date(p.snapshotAt) ||
      !date(p.issuedAt) ||
      !date(p.expiresAt) ||
      typeof p.lastSortValue !== 'string' ||
      typeof p.lastTieBreaker !== 'string' ||
      typeof p.queryTag !== 'string'
    )
      invalid();
    const now = Date.now();
    if (
      Date.parse(p.issuedAt) > now ||
      Date.parse(p.expiresAt) <= now ||
      Date.parse(p.expiresAt) - Date.parse(p.issuedAt) !== TTL_MS ||
      Date.parse(p.snapshotAt) > Date.parse(p.issuedAt)
    )
      invalid();
    const lastDate =
      p.sort === 'createdAt' ? p.lastSortValue : p.lastTieBreaker;
    const lastId = p.sort === 'id' ? p.lastSortValue : p.lastTieBreaker;
    if (
      !date(lastDate) ||
      lastId.length !== 36 ||
      !UUID.test(lastId) ||
      Date.parse(lastDate) >= Date.parse(p.snapshotAt)
    )
      invalid();
    if (!equal(bytes(p.queryTag), bytes(this.queryTag(query, key)))) invalid();
    return p as unknown as ListCursor;
  }

  private key(kid: string): Buffer | null {
    const entry = this.config
      .get('USER_LIST_CURSOR_HMAC_KEYS')
      .find((k) => k.kid === kid);
    return entry ? decodeKey(entry.key) : null;
  }

  private hmac(key: Buffer, domain: string, value: string): Buffer {
    try {
      return createHmac('sha256', key).update(`${domain}:${value}`).digest();
    } catch {
      throw new AppException('service_unavailable');
    }
  }

  private queryTag(query: UserListQuery, key: Buffer): string {
    const canonical = JSON.stringify({
      limit: query.limit,
      searchBy: query.searchBy ?? null,
      q: query.q ?? null,
      status: query.status ?? null,
      sort: query.sort,
      order: query.order,
    });
    return this.hmac(key, 'users-list-query', canonical).toString('base64url');
  }
}
