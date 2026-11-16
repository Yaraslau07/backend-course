import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/core/app/app.module';
import { configureApp, createAdapter } from '@/core/app/configure-app';
import { AppConfig } from '@/core/config/config.types';
import { validate } from '@/core/config/config.validation';

/** Boots the real AppModule with the same adapter and setup as main.ts. */
export async function createTestApp(): Promise<{
  app: NestFastifyApplication;
  config: AppConfig;
}> {
  const config = validate(process.env);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAdapter(config),
    { bufferLogs: true },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return { app, config };
}
