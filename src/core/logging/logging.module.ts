import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import type { DestinationStream, Level } from 'pino';
import { LoggerModule } from 'nestjs-pino';

import { ConfigService } from '@/core/config/config.service';

import { genReqId } from './request-id';

/** Where logs go instead of stdout, and at which level. Tests override it to capture logs. */
export interface LogSink {
  level: Level;
  stream: DestinationStream;
}
export const LOG_SINK = Symbol('LOG_SINK');

/**
 * Paths pino replaces with "[Redacted]". This is a safety net: serializers below already log
 * only method, route pattern, status and timing. Never log the values listed in docs/invariants.md.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.code',
  '*.secret',
  '*.email',
  '*.accessKeyId',
  '*.secretAccessKey',
  '*.S3_ACCESS_KEY_ID',
  '*.S3_SECRET_ACCESS_KEY',
];

/** The pattern of the matched route (`/users/:userId`), put on the raw request in configureApp. */
export type RoutedMessage = IncomingMessage & { routePattern?: string };

/**
 * Logs the method only, never the URL: a path segment can be a target id, which spec 1.3 §1.5 allows
 * in logs only once it may be read (and spec 1.6 never, for deletion), and the query string can
 * carry search terms and cursors. pino-http binds this at the start of the request, before the
 * route is known; the route pattern is added to the completion line instead (`withRoute`, D49).
 */
export function serializeRequest(req: RoutedMessage) {
  return { id: req.id, method: req.method };
}

/**
 * The completion line's extra field: the matched route pattern (`/users/:userId`), or null for a
 * request that matched none, whose URL could be anything.
 */
export function withRoute<T extends object>(
  req: RoutedMessage,
  value: T,
): T & { route: string | null } {
  return { ...value, route: req.routePattern ?? null };
}

export function serializeResponse(res: ServerResponse) {
  return { statusCode: res.statusCode };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService, LOG_SINK],
      providers: [{ provide: LOG_SINK, useValue: null }],
      useFactory: (config: ConfigService, sink: LogSink | null) => {
        const env = config.get('NODE_ENV');
        const options = {
          level: sink?.level ?? (env === 'test' ? 'silent' : 'info'),
          // Fastify has already assigned the id (createAdapter); reuse it so logs and X-Request-Id match.
          genReqId: (req: IncomingMessage & { id?: string }) =>
            req.id ?? genReqId(req),
          redact: { paths: REDACT_PATHS },
          serializers: {
            req: serializeRequest,
            res: serializeResponse,
          },
          customSuccessObject: (
            req: RoutedMessage,
            _res: ServerResponse,
            value: object,
          ) => withRoute(req, value),
          customErrorObject: (
            req: RoutedMessage,
            _res: ServerResponse,
            _error: Error,
            value: object,
          ) => withRoute(req, value),
          customProps: () => ({ service: 'backend-course' }),
          transport:
            env === 'development' && !sink
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        };
        return { pinoHttp: sink ? [options, sink.stream] : options };
      },
    }),
  ],
})
export class LoggingModule {}
