import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Fastify's request id generator (see `createAdapter`). Reuses a caller's id only if it is a UUID,
 * since anything else could inject content into logs. The id is echoed in `X-Request-Id`
 * (`configureApp`) and picked up by pino-http as `req.id`.
 */
export function genReqId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && UUID.test(incoming)
    ? incoming.toLowerCase()
    : randomUUID();
}
