import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppConfig } from '@/core/config/config.types';
import { AppException } from '@/core/errors/app.exception';
import { validationExceptionFactory } from '@/core/errors/validation';
import { genReqId } from '@/core/logging/request-id';
import { duplicateJsonKey } from './json-keys';

export const ACCESS_COOKIE = 'access_token';

/** Headers a trusted cross-origin frontend may send (CSRF marker, idempotency, deletion receipt). */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'X-CSRF-Protection',
  'Idempotency-Key',
  'Deletion-Receipt',
];
export const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'Retry-After',
  'X-Transformation-Id',
  'X-Save-Status',
];

/** JSON bodies are small; file uploads get their own limits from the multipart plugin later. */
const JSON_BODY_LIMIT = 1024 * 1024;

export function createAdapter(config: AppConfig): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: JSON_BODY_LIMIT,
    genReqId,
    // genReqId reads and validates the header itself; don't let Fastify trust it blindly.
    requestIdHeader: false,
  });
}

/**
 * Everything applied to the Nest app between create() and listen().
 * Shared by main.ts and the e2e tests, so tests exercise exactly the production setup.
 */
export async function configureApp(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<void> {
  app.useLogger(app.get(Logger));

  const fastify = app.getHttpAdapter().getInstance();
  // Expose Fastify's id on the raw request for pino-http, and echo it to the client.
  fastify.addHook('onRequest', (request, _reply, done) => {
    const raw = request.raw as typeof request.raw & {
      id?: string;
      routePattern?: string;
    };
    raw.id = request.id;
    // The matched route's pattern for the request log (D49); undefined for a 404.
    raw.routePattern = request.routeOptions.url;
    done();
  });
  fastify.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });

  await app.register(helmet, {
    // JSON API: no HTML to protect with CSP. Swagger UI (dev only) would also break under it.
    contentSecurityPolicy: false,
    hsts:
      config.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
  });

  // Fastify's JSON parser (with prototype-poisoning protection), but failing with our own
  // invalid_json. Nest would otherwise wrap Fastify's error into an anonymous 400. Registering it
  // here also stops Nest from installing its parser at init().
  const parseJson = fastify.getDefaultJsonParser('error', 'error');
  app.useBodyParser(
    'application/json',
    { bodyLimit: JSON_BODY_LIMIT },
    (request, body, done) => {
      // Nest hands over a Buffer and types the request loosely (HTTP/2 too); this app is HTTP/1 only.
      const source = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      void parseJson(
        request as Parameters<typeof parseJson>[0],
        source,
        (error, value) => {
          if (error) done(new AppException('invalid_json'), undefined);
          else if (duplicateJsonKey(source))
            done(new AppException('bad_request'), undefined);
          else done(null, value);
        },
      );
    },
  );

  // Auth cookies are plain JWTs with their own signatures, so no cookie-signing secret.
  await app.register(fastifyCookie);
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 1,
      headerPairs: 20,
    },
  });

  app.enableCors({
    origin: config.CORS_ORIGINS, // exact origins only, never "*", because requests carry credentials
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Field names and rule names only; see src/core/errors/validation.ts.
      exceptionFactory: validationExceptionFactory,
    }),
  );

  app.enableShutdownHooks();

  if (config.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Backend Course API')
        .setVersion('0.1.0')
        .addCookieAuth(
          ACCESS_COOKIE,
          { type: 'apiKey', in: 'cookie', name: ACCESS_COOKIE },
          ACCESS_COOKIE,
        )
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      // The UI needs @fastify/static, which pulls an ESM-only dependency Jest can't load.
      // Tests only need the JSON document (/docs-json).
      ui: config.NODE_ENV !== 'test',
    });
  }
}
