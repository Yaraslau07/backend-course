/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import { type OnModuleInit } from '@nestjs/common';
import type { Transporter } from 'nodemailer';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type {
  CheckResult,
  ReadinessRegistry,
} from '@/core/health/readiness.registry';

import type { ChallengeMailInput } from './templates';

export const MAIL_TIMEOUT_MS = 2000;
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
export type MailTransport = Pick<Transporter, 'sendMail' | 'verify'>;

export class MailUnavailableError extends AppException {
  constructor(readonly reason: string) {
    super('service_unavailable');
  }
}

export class MailService implements OnModuleInit {
  constructor(
    private readonly transport: MailTransport,
    private readonly config: ConfigService,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    throw new Error('not implemented');
  }

  sendChallenge(_to: string, _input: ChallengeMailInput): Promise<void> {
    throw new Error('not implemented');
  }

  check(): Promise<CheckResult> {
    throw new Error('not implemented');
  }
}
