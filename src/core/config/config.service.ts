import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import { AppConfig } from './config.types';

/** Typed accessor over the validated config: `get('CORS_ORIGINS')` returns `string[]`, `get('PORT')` a number. */
@Injectable()
export class ConfigService {
  constructor(private readonly nestConfig: NestConfigService) {}

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.nestConfig.get(key) as AppConfig[K];
  }
}
