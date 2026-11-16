import { Injectable, Logger } from '@nestjs/common';

export type CheckResult = 'up' | { down: string };
export type ReadinessCheck = () => Promise<CheckResult>;

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, 'up' | 'down'>;
}

export const CHECK_TIMEOUT_MS = 1000;

/**
 * Modules register what must be true before the app can take protected traffic:
 * DB, keys, RBAC snapshot, route declarations, erasers, cursor key ring, SMTP …
 * A check that throws, rejects or exceeds the timeout counts as down. Reasons are logged, never returned.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly logger = new Logger(ReadinessRegistry.name);
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    if (this.checks.has(name)) {
      throw new Error(`Readiness check "${name}" is already registered`);
    }
    this.checks.set(name, check);
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  async run(timeoutMs = CHECK_TIMEOUT_MS): Promise<ReadinessReport> {
    const results = await Promise.all(
      [...this.checks].map(
        async ([name, check]) =>
          [name, await this.runOne(name, check, timeoutMs)] as const,
      ),
    );

    const checks = Object.fromEntries(results) as ReadinessReport['checks'];
    // No checks registered means nothing has proven the app ready.
    const ok =
      results.length > 0 && results.every(([, state]) => state === 'up');
    return { status: ok ? 'ok' : 'unavailable', checks };
  }

  private async runOne(
    name: string,
    check: ReadinessCheck,
    timeoutMs: number,
  ): Promise<'up' | 'down'> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<CheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ down: 'timeout' }), timeoutMs);
      });
      const result = await Promise.race([check(), timeout]);
      if (result === 'up') return 'up';
      this.logger.warn(
        { check: name, reason: result.down },
        'readiness check down',
      );
      return 'down';
    } catch (error) {
      this.logger.warn(
        { check: name, reason: (error as Error)?.name ?? 'error' },
        'readiness check threw',
      );
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
