import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ReadinessRegistry } from '@/core/health/readiness.registry';

import type { PolicySnapshot } from './policy-snapshot';

/**
 * Spec 1.1 §1.3.6: the snapshot of this instance, checked against `rbac_policy_state.version`
 * before every access check and replaced whole after a successful reload.
 */
@Injectable()
export class RbacPolicyStore {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly readiness: ReadinessRegistry,
  ) {}

  /** The snapshot at the database's current version, or `503 authorization_unavailable`. */
  current(): Promise<PolicySnapshot> {
    throw new Error('not implemented');
  }
}
