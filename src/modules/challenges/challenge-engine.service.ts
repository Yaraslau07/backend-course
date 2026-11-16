/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { ErrorCode } from '@/core/errors/error-catalogue';
import { MailService } from '@/core/mail/mail.service';
import type { ChallengeScenario } from '@/core/mail/templates';

import type {
  ChallengeConsumedReason,
  ChallengeMethod,
} from './challenges.types';

export type ChallengeRef = { challengeId: string } | { token: string };

export interface IssuedChallenge {
  scenario: ChallengeScenario;
  id: string;
  method: ChallengeMethod;
  secret: string;
}

export interface ChallengeRecord {
  id: string;
  userId: string;
  method: ChallengeMethod;
  attempts: number;
  newEmail: string | null;
}

export class ChallengeRejected extends AppException {
  constructor(
    code: ErrorCode,
    readonly reason: string,
    extras: { retryAfterSeconds?: number } = {},
  ) {
    super(code, extras);
  }
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChallengeRejected };

export type ConfirmInput = (
  | { challengeId: string; code: string }
  | { token: string }
) & {
  userId: string;
  userEligible: boolean;
};

@Injectable()
export class ChallengeEngine {
  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  findUserId(
    _m: EntityManager,
    _s: ChallengeScenario,
    _ref: ChallengeRef,
  ): Promise<string | null> {
    throw new Error('not implemented');
  }
  issue(
    _m: EntityManager,
    _s: ChallengeScenario,
    _input: { userId: string; method: ChallengeMethod; newEmail?: string },
  ): Promise<Outcome<IssuedChallenge>> {
    throw new Error('not implemented');
  }
  resend(
    _m: EntityManager,
    _s: ChallengeScenario,
    _input: { challengeId: string; userId: string; userEligible: boolean },
  ): Promise<Outcome<IssuedChallenge>> {
    throw new Error('not implemented');
  }
  confirm(
    _m: EntityManager,
    _s: ChallengeScenario,
    _input: ConfirmInput,
  ): Promise<Outcome<ChallengeRecord>> {
    throw new Error('not implemented');
  }
  claim(
    _m: EntityManager,
    _s: ChallengeScenario,
    _id: string,
    _r: ChallengeConsumedReason,
  ): Promise<boolean> {
    throw new Error('not implemented');
  }
  consumeOutstanding(
    _m: EntityManager,
    _s: ChallengeScenario,
    _userId: string,
    _r: ChallengeConsumedReason,
  ): Promise<number> {
    throw new Error('not implemented');
  }
  accepted(_issued: IssuedChallenge): Record<string, unknown> {
    throw new Error('not implemented');
  }
  deliver(_to: string, _issued: IssuedChallenge): Promise<void> {
    throw new Error('not implemented');
  }
}
