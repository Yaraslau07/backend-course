import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Readable } from 'node:stream';

import { ConfigService } from '@/core/config/config.service';
import { Ownership } from '@/core/authorization/ownership';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { ObjectStorage } from '@/modules/storage/object-storage';

import type { SafeProfile } from './safe-profile';
import { UserListCursor } from './user-list-cursor.service';

@Injectable()
export class UsersReadService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly ownership: Ownership,
    private readonly limiter: RateLimiter,
    private readonly storage: ObjectStorage,
    private readonly cursors: UserListCursor,
  ) {}

  profile(actor: string, target: string): Promise<SafeProfile> {
    void actor;
    void target;
    throw new Error('not implemented');
  }

  photo(actor: string, target: string): Promise<Readable> {
    void actor;
    void target;
    throw new Error('not implemented');
  }

  list(
    actor: string,
    raw: unknown,
  ): Promise<{ items: SafeProfile[]; nextCursor: string | null }> {
    void actor;
    void raw;
    throw new Error('not implemented');
  }
}
