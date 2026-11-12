import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { decodeKey, SECRET_KEY_NAMES } from '@/core/config/config.validation';

import { CheckResult, ReadinessRegistry } from './readiness.registry';

/** Checks that exist from day one. Feature modules register their own the same way in `onModuleInit`. */
@Injectable()
export class BuiltinReadinessChecks implements OnModuleInit {
  constructor(
    private readonly registry: ReadinessRegistry,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.registry.register('database', () => this.database());
    this.registry.register('config', () => Promise.resolve(this.keys()));
  }

  async database(): Promise<CheckResult> {
    if (!this.dataSource.isInitialized) return { down: 'not_initialized' };
    await this.dataSource.query('SELECT 1');
    return 'up';
  }

  /**
   * Boot already fails fast on bad keys; this makes "missing keys fail readiness" explicit
   * and keeps holding if config is ever reloaded at runtime.
   */
  keys(): CheckResult {
    const keys = [
      ...SECRET_KEY_NAMES.map((name) => this.config.get(name)),
      ...(this.config.get('USER_LIST_CURSOR_HMAC_KEYS') ?? []).map(
        (k) => k.key,
      ),
    ];
    const ring = this.config.get('USER_LIST_CURSOR_HMAC_KEYS') ?? [];
    const activeKid = this.config.get('USER_LIST_CURSOR_ACTIVE_KEY_ID');
    if (keys.some((k) => typeof k !== 'string' || !decodeKey(k)))
      return { down: 'invalid_key' };
    if (!ring.some((k) => k.kid === activeKid))
      return { down: 'cursor_active_kid' };
    return 'up';
  }
}
