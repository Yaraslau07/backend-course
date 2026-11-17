import { AppException } from '@/core/errors/app.exception';

import { USER_STATUSES, type UserStatus } from './users.types';

export interface UserListQuery {
  limit: number;
  sort: 'createdAt' | 'id';
  order: 'asc' | 'desc';
  searchBy?: 'id' | 'email' | 'displayName';
  q?: string;
  status?: UserStatus;
  cursor?: string;
}

export function parseUserListQuery(raw: unknown): UserListQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const input = raw as Record<string, unknown>;
  const allowed = new Set([
    'limit',
    'sort',
    'order',
    'searchBy',
    'q',
    'status',
    'cursor',
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key) || typeof value !== 'string') bad();
  }
  const {
    limit = '20',
    sort = 'createdAt',
    order = 'desc',
    searchBy,
    status,
    cursor,
  } = input;
  if (
    typeof limit !== 'string' ||
    limit.length < 1 ||
    limit.length > 3 ||
    /[^0-9]/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100
  )
    bad();
  if (sort !== 'id' && sort !== 'createdAt') bad();
  if (order !== 'asc' && order !== 'desc') bad();
  const result: UserListQuery = { limit: Number(limit), sort, order };
  if (status !== undefined) {
    if (!USER_STATUSES.includes(status as UserStatus)) bad();
    result.status = status as UserStatus;
  }
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !cursor.length || cursor.length > 8192)
      throw new AppException('invalid_cursor');
    result.cursor = cursor;
  }
  if (searchBy === undefined && input.q === undefined) return result;
  if (typeof input.q !== 'string') bad();
  let q = input.q;
  switch (searchBy) {
    case 'id':
      validateUserId(q);
      break;
    case 'email':
      q = q.trim().toLowerCase();
      if (!/^[\x21-\x7e]{3,254}$/.test(q)) bad();
      break;
    case 'displayName':
      q = q.trim().normalize('NFC');
      if (
        [...q].length < 3 ||
        [...q].length > 80 ||
        [...q].some(
          (c) =>
            c.codePointAt(0)! < 32 ||
            (c.codePointAt(0)! >= 127 && c.codePointAt(0)! <= 159),
        )
      )
        bad();
      break;
    default:
      bad();
  }
  result.searchBy = searchBy;
  result.q = q;
  return result;
}

export function validateUserId(value: string): string {
  if (value.length < 1 || value.length > 128 || /[^A-Za-z0-9_-]/.test(value))
    bad();
  return value;
}

function bad(): never {
  throw new AppException('bad_request');
}
