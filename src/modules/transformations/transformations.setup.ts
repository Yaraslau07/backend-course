import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ReadinessRegistry } from '@/core/health/readiness.registry';
import { UserDataErasers } from '@/modules/erasure/user-data-erasers';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';

import {
  ACCESS_READY_SQL,
  TRANSFORMATIONS_SEED,
} from './transformations-access';
import { TransformationsEraser } from './transformations-eraser';

/**
 * Wires the module into the shared registries before anything stores user data: the permission
 * seed (applied by the RBAC bootstrap), the eraser (spec 1.6 §1.3.5) and the readiness check.
 */
@Injectable()
export class TransformationsSetup implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly seeds: RbacPermissionSeeds,
    private readonly erasers: UserDataErasers,
    private readonly eraser: TransformationsEraser,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.seeds.register(TRANSFORMATIONS_SEED);
    this.erasers.register(this.eraser);
    this.readiness.register('transformations', async () => {
      const [{ ready }] =
        await this.db.query<{ ready: boolean }[]>(ACCESS_READY_SQL);
      return ready ? 'up' : { down: 'rbac_not_seeded' };
    });
  }
}
