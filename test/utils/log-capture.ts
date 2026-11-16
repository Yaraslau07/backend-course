import { Writable } from 'node:stream';

import { SECRET_KEY_NAMES } from '@/core/config/config.validation';
import type { AppConfig } from '@/core/config/config.types';
import type { LogSink } from '@/core/logging/logging.module';

/**
 * Collects every log line the app writes, so tests can assert that nothing from
 * "Logging (never log)" in docs/invariants.md ends up in the logs.
 *
 * nestjs-pino keeps one root logger per process (per Jest test file), so create the
 * capturing app once per file, in `beforeAll`.
 */
export class LogCapture {
  private readonly chunks: string[] = [];

  readonly sink: LogSink = {
    level: 'debug',
    stream: new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.chunks.push(chunk.toString('utf8'));
        done();
      },
    }),
  };

  text(): string {
    return this.chunks.join('');
  }

  lines(): Record<string, unknown>[] {
    return this.text()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  clear(): void {
    this.chunks.length = 0;
  }

  /**
   * Fails if any of `values`, or any secret from the config, appears anywhere in the logs.
   * Pass the sensitive values the test itself sent: emails, passwords, codes, tokens, bodies.
   */
  expectNoLeaks(config: AppConfig, values: string[] = []): void {
    const secrets = [
      ...SECRET_KEY_NAMES.map((name) => config[name]),
      ...config.USER_LIST_CURSOR_HMAC_KEYS.map((entry) => entry.key),
      config.POSTGRES_PASSWORD,
    ];
    const text = this.text();
    for (const value of [...secrets, ...values]) {
      if (value.length === 0) continue;
      // Not `expect(text).not.toContain(value)`: that would print the secret in the failure message.
      if (text.includes(value)) {
        throw new Error(
          `A sensitive value (${value.length} characters, starting "${value.slice(0, 3)}…") was logged`,
        );
      }
    }
  }
}
