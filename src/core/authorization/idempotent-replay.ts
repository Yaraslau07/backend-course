import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * What a replay matcher decided about a request, before any session check (spec 1.6 §1.3.2 step 2):
 * - `replay`: the key names an operation already accepted for this target; the handler answers it;
 * - `conflict`: the key belongs to a different target (409);
 * - `none`: no such operation yet, so the full protected chain runs.
 */
export type ReplayVerdict = 'replay' | 'conflict' | 'none';
export type ReplayMatcher = (request: FastifyRequest) => Promise<ReplayVerdict>;

/**
 * Matchers for `@Replay(name)` routes, registered by the feature that owns the operation. A route
 * whose matcher is missing falls back to the full chain, so a wiring mistake never opens a route.
 */
@Injectable()
export class IdempotentReplays {
  private readonly matchers = new Map<string, ReplayMatcher>();

  register(name: string, matcher: ReplayMatcher): void {
    if (this.matchers.has(name)) {
      throw new Error(`Replay matcher "${name}" is already registered`);
    }
    this.matchers.set(name, matcher);
  }

  async check(name: string, request: FastifyRequest): Promise<ReplayVerdict> {
    const matcher = this.matchers.get(name);
    return matcher ? matcher(request) : 'none';
  }
}
