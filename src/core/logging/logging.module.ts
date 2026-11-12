import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ConfigService } from '@/core/config/config.service';

import { genReqId } from './request-id';

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
];

/**
 * Logs method and path only. The query string is dropped: it can carry search terms (`q`) and cursors,
 * which must not be logged. Path segments are ids (allowed); magic-link tokens travel in URL fragments
 * and POST bodies, never in paths.
 */
export function serializeRequest(req: IncomingMessage) {
  return {
    id: req.id,
    method: req.method,
    path: (req.url ?? '').split('?')[0],
  };
}

export function serializeResponse(res: ServerResponse) {
  return { statusCode: res.statusCode };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const env = config.get('NODE_ENV');
        return {
          pinoHttp: {
            level: env === 'test' ? 'silent' : 'info',
            // Fastify has already assigned the id (createAdapter); reuse it so logs and X-Request-Id match.
            genReqId: (req: IncomingMessage & { id?: string }) =>
              req.id ?? genReqId(req),
            redact: { paths: REDACT_PATHS },
            serializers: {
              req: serializeRequest,
              res: serializeResponse,
            },
            customProps: () => ({ service: 'backend-course' }),
            transport:
              env === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggingModule {}
