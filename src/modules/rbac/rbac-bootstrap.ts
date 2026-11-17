/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

export type BootstrapResult =
  | 'bootstrapped'
  | 'not_empty'
  | 'no_admin_configured'
  | 'admin_not_active';

/**
 * Spec 1.1 §1.1: the one-time setup of an empty RBAC configuration. Runs at startup; there is no
 * endpoint. Without a usable admin it does nothing and runs again at the next start (D45).
 */
@Injectable()
export class RbacBootstrap {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  run(_adminUserId: string | undefined): Promise<BootstrapResult> {
    throw new Error('not implemented');
  }
}
