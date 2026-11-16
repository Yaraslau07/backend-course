import type { Type } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/core/app/app.module';
import { configureApp, createAdapter } from '@/core/app/configure-app';
import { ConfigService } from '@/core/config/config.service';
import { AppConfig } from '@/core/config/config.types';
import { validate } from '@/core/config/config.validation';
import { LOG_SINK } from '@/core/logging/logging.module';

import type { LogCapture } from './log-capture';

export interface TestAppOptions {
  /** Extra modules, for example test-only controllers. */
  imports?: Type[];
  /** Capture the app's logs (see LogCapture). Logging is silent otherwise. */
  logs?: LogCapture;
  /**
   * Variables that differ for this app only, e.g. `{ SMTP_PORT: '1' }`. Nest's ConfigModule reads
   * the environment once per process, so changing `process.env` between apps would have no effect.
   */
  env?: Record<string, string>;
}

/** Boots the real AppModule with the same adapter and setup as main.ts. */
export async function createTestApp(options: TestAppOptions = {}): Promise<{
  app: NestFastifyApplication;
  config: AppConfig;
}> {
  const config = validate({ ...process.env, ...options.env });
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(LOG_SINK)
    .useValue(options.logs?.sink ?? null);
  if (options.env) {
    builder = builder.overrideProvider(ConfigService).useValue({
      get: <K extends keyof AppConfig>(key: K): AppConfig[K] => config[key],
    });
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAdapter(config),
    { bufferLogs: true },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return { app, config };
}
