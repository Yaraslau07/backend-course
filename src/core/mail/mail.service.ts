import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Transporter } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import {
  type CheckResult,
  ReadinessRegistry,
} from '@/core/health/readiness.registry';

import {
  type ChallengeMailInput,
  type RenderedMail,
  renderChallengeMail,
} from './templates';

/** The whole send (connect, greeting, transfer) must finish within this, or it is a 503 (D33). */
export const MAIL_TIMEOUT_MS = 2000;
/** How long a readiness answer about SMTP is reused, so probes don't open a connection each time. */
export const MAIL_CHECK_CACHE_MS = 30_000;
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
export type MailTransport = Pick<Transporter, 'sendMail' | 'verify'>;

/**
 * SMTP didn't take the message. It is a `503 service_unavailable` on its own; flows that must keep
 * their challenge catch it and answer with their own 503 body (confirmationRequired, method, id).
 */
export class MailUnavailableError extends AppException {
  constructor(readonly reason: string) {
    super('service_unavailable');
  }
}

class MailTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A safe failure category: our timeout, nodemailer's or the socket's error code, or "error". */
function failureReason(error: unknown): string {
  if (error instanceof MailTimeout) return 'timeout';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)
    ? code
    : 'error';
}

/**
 * Sends mail over SMTP. Logs the template, outcome and duration only: never the recipient, the
 * subject, the body, or a transport message (those quote addresses and server responses).
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger('Mail');
  private lastCheck?: { at: number; result: CheckResult };

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly config: ConfigService,
    private readonly registry: ReadinessRegistry,
  ) {}

  /**
   * Reported in readiness, but not critical (D37): only the challenge flows need SMTP, and they
   * answer 503 themselves. An SMTP outage must not take logins, profiles and lists down with it.
   */
  onModuleInit(): void {
    this.registry.register('smtp', () => this.check(), { critical: false });
  }

  /** Throws MailUnavailableError when SMTP fails or takes longer than MAIL_TIMEOUT_MS. */
  async sendChallenge(to: string, input: ChallengeMailInput): Promise<void> {
    await this.send(
      to,
      renderChallengeMail(input, this.config.get('FRONTEND_URL')),
    );
  }

  async send(to: string, mail: RenderedMail): Promise<void> {
    const started = Date.now();
    try {
      await withTimeout(
        this.transport.sendMail({
          from: this.config.get('MAIL_FROM'),
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
        MAIL_TIMEOUT_MS,
      );
    } catch (error) {
      const reason = failureReason(error);
      this.logger.warn(
        { template: mail.template, reason, durationMs: Date.now() - started },
        'mail delivery failed',
      );
      throw new MailUnavailableError(reason);
    }
    this.logger.log(
      { template: mail.template, durationMs: Date.now() - started },
      'mail sent',
    );
  }

  /** Readiness: the server accepts a connection (and our credentials). Cached for 30 s. */
  async check(): Promise<CheckResult> {
    const now = Date.now();
    if (this.lastCheck && now - this.lastCheck.at < MAIL_CHECK_CACHE_MS) {
      return this.lastCheck.result;
    }
    let result: CheckResult;
    try {
      await withTimeout(this.transport.verify(), MAIL_TIMEOUT_MS);
      result = 'up';
    } catch (error) {
      result = { down: failureReason(error) };
    }
    this.lastCheck = { at: now, result };
    return result;
  }
}
