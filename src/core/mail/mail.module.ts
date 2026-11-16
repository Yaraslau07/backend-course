import { Global, Module } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';

import { MAIL_TIMEOUT_MS, MAIL_TRANSPORT, MailService } from './mail.service';

/** Global: registration, login, email change and deletion all send challenge mail. */
@Global()
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const user = config.get('SMTP_USER');
        return createTransport({
          host: config.get('SMTP_HOST'),
          port: config.get('SMTP_PORT'),
          secure: config.get('SMTP_SECURE'),
          // In production a code never crosses the network in clear text: STARTTLS is required
          // unless the connection is TLS from the start (SMTP_SECURE). Mailpit locally has no TLS.
          requireTLS:
            config.get('NODE_ENV') === 'production' &&
            !config.get('SMTP_SECURE'),
          auth: user ? { user, pass: config.get('SMTP_PASSWORD') } : undefined,
          connectionTimeout: MAIL_TIMEOUT_MS,
          greetingTimeout: MAIL_TIMEOUT_MS,
          socketTimeout: MAIL_TIMEOUT_MS,
          // Its own logging would print addresses and SMTP traffic.
          logger: false,
          debug: false,
          // Messages are built from our templates only; never read files or fetch URLs.
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      },
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
