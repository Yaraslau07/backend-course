import type { UserStatus } from './users.types';

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
  void raw;
  throw new Error('not implemented');
}

export function validateUserId(value: string): string {
  void value;
  throw new Error('not implemented');
}
