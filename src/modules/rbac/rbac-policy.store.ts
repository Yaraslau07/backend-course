import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import { classifyDbError } from '@/core/errors/db-errors';
import { ReadinessRegistry } from '@/core/health/readiness.registry';

import {
  PolicyInconsistency,
  type PolicyRows,
  PolicySnapshot,
} from './policy-snapshot';
import { RbacBootstrap } from './rbac-bootstrap';

const unavailable = () => new AppException('authorization_unavailable');

/**
 * Spec 1.1 §1.3.6: this instance's snapshot of the policy. Before every access check the
 * database version is read; if it differs, the whole policy is read again in one REPEATABLE READ
 * transaction and swapped in only if it is coherent. While a reload fails, there is no snapshot at
 * all: protected routes answer 503 and readiness is down, never an old policy.
 */
@Injectable()
export class RbacPolicyStore implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('Rbac');
  private snapshot: PolicySnapshot | null = null;
  /** One reload at a time; concurrent requests wait for the same one. */
  private loading: Promise<PolicySnapshot> | null = null;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly readiness: ReadinessRegistry,
    private readonly bootstrap: RbacBootstrap,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.readiness.register('rbac', () =>
      Promise.resolve(this.snapshot ? 'up' : { down: 'policy_not_loaded' }),
    );
  }

  /** Bootstrap (if the policy is empty), then the first load. Readiness stays down until it works. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.bootstrap.run(this.config.get('RBAC_BOOTSTRAP_ADMIN_USER_ID'));
    } catch (error) {
      this.logger.error(
        { event: 'rbac_bootstrap', result: 'failure', error: errorName(error) },
        'RBAC bootstrap failed',
      );
    }
    await this.load().catch(() => undefined);
  }

  /** The snapshot at the database's current version, or `503 authorization_unavailable`. */
  async current(): Promise<PolicySnapshot> {
    const version = await this.databaseVersion();
    if (this.snapshot?.version === version) return this.snapshot;

    let loaded = await this.load();
    // A reload that was already running may have read an older version than ours.
    if (BigInt(loaded.version) < BigInt(version))
      loaded = await this.load(true);
    return loaded;
  }

  private async databaseVersion(): Promise<string> {
    try {
      const rows = await this.db.query<{ version: string }[]>(
        `SELECT version FROM rbac_policy_state WHERE id = 1`,
      );
      if (!rows[0]) throw new PolicyInconsistency('policy state row missing');
      return rows[0].version;
    } catch (error) {
      if (
        !(error instanceof PolicyInconsistency) &&
        classifyDbError(error)?.kind !== 'unavailable'
      ) {
        throw error;
      }
      this.logger.error(
        {
          event: 'rbac_version_check',
          result: 'failure',
          error: errorName(error),
        },
        'RBAC policy version unavailable',
      );
      throw unavailable();
    }
  }

  private load(fresh = false): Promise<PolicySnapshot> {
    if (this.loading && !fresh) return this.loading;
    const run = this.read().finally(() => {
      if (this.loading === run) this.loading = null;
    });
    this.loading = run;
    return run;
  }

  private async read(): Promise<PolicySnapshot> {
    const previous = this.snapshot?.version ?? null;
    try {
      const rows = await this.db.transaction(
        'REPEATABLE READ',
        async (manager): Promise<PolicyRows> => {
          const [state] = await manager.query<{ version: string }[]>(
            `SELECT version FROM rbac_policy_state WHERE id = 1`,
          );
          if (!state) throw new PolicyInconsistency('policy state row missing');
          return {
            version: state.version,
            roles: await manager.query(`SELECT id, name FROM roles`),
            permissions: await manager.query(
              `SELECT id, name FROM permissions`,
            ),
            permissionActions: await manager.query(
              `SELECT permission_id, action FROM permission_actions`,
            ),
            grants: await manager.query(
              `SELECT id, role_id, permission_id, all_actions FROM grants`,
            ),
            grantActions: await manager.query(
              `SELECT grant_id, permission_id, action FROM grant_actions`,
            ),
          };
        },
      );
      const snapshot = PolicySnapshot.build(rows);
      this.snapshot = snapshot;
      this.logger.log(
        {
          event: 'rbac_reload',
          result: 'success',
          version: snapshot.version,
          previous,
        },
        'RBAC policy loaded',
      );
      return snapshot;
    } catch (error) {
      // Never keep serving the old policy once it is known to be stale (spec 1.1 §1.3.6 step 6).
      this.snapshot = null;
      this.logger.error(
        {
          event: 'rbac_reload',
          result: 'failure',
          previous,
          reason:
            error instanceof PolicyInconsistency
              ? error.reason
              : errorName(error),
        },
        'RBAC policy reload failed',
      );
      throw unavailable();
    }
  }
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : 'unknown';
