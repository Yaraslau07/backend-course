import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { config as loadEnv } from 'dotenv';

import { AppModule } from '@/core/app/app.module';
import { configureApp, createAdapter } from '@/core/app/configure-app';
import { validate } from '@/core/config/config.validation';

async function bootstrap() {
  // The adapter needs TRUST_PROXY before Nest (and its ConfigModule) exists, so validate here too.
  // Same function, same rules: a bad env fails before anything listens.
  loadEnv({ path: '.env', quiet: true });
  const config = validate(process.env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(config),
    {
      bufferLogs: true,
    },
  );
  await configureApp(app, config);

  // 0.0.0.0 so the container is reachable; Fastify's default is loopback only.
  await app.listen(config.PORT, '0.0.0.0');
}

void bootstrap();
