import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

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

@Injectable()
export class UserListCursor {
  constructor(private readonly config: ConfigService) {}

  encode(
    query: UserListQuery,
    last: Pick<ProfileRow, 'id' | 'created_at'>,
    boundary: string | ListCursor,
  ): string {
    void query;
    void last;
    void boundary;
    throw new Error('not implemented');
  }

  decode(token: string, query: UserListQuery): ListCursor {
    void token;
    void query;
    throw new Error('not implemented');
  }
}
