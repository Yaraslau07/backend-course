import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ReplayVerdict } from '@/core/authorization/idempotent-replay';
import type { DeletionJobStatus } from './users.types';

/** The 202 answer of every accepted (or replayed) deletion (spec 1.6 §1.3.2, §1.3.3). */
export interface DeletionReceipt {
  jobId: string;
  status: DeletionJobStatus;
  statusUrl: string;
}

/** The status answer (spec 1.6 §1.3.4). */
export interface DeletionStatus {
  jobId: string;
  status: DeletionJobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

@Injectable()
export class UsersDeletionService {
  startChallenge(
    actor: string,
    target: string,
  ): Promise<Record<string, unknown>> {
    void actor;
    void target;
    throw new Error('not implemented');
  }

  resendChallenge(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    void [actor, target, raw];
    throw new Error('not implemented');
  }

  confirm(
    actor: string | undefined,
    target: string,
    key: unknown,
    raw: unknown,
  ): Promise<DeletionReceipt> {
    void [actor, target, key, raw];
    throw new Error('not implemented');
  }

  adminDelete(
    actor: string,
    target: string,
    key: unknown,
  ): Promise<DeletionReceipt> {
    void [actor, target, key];
    throw new Error('not implemented');
  }

  status(
    actor: string | undefined,
    target: string,
    receipt: unknown,
  ): Promise<DeletionStatus> {
    void [actor, target, receipt];
    throw new Error('not implemented');
  }

  matchReplay(request: FastifyRequest): Promise<ReplayVerdict> {
    void request;
    throw new Error('not implemented');
  }
}
