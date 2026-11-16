import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { toErrorResponse } from './error-response';

/**
 * The only place an error response is written. Registered globally (ErrorsModule), so it also
 * handles unknown routes and Fastify's body-parser errors, which Nest routes through its filters.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const response = toErrorResponse(exception);

    if (response.log.level !== 'none') {
      const fields = {
        ...response.log.fields,
        requestId: request.id,
        statusCode: response.status,
        // Not `code`: the logger redacts `*.code` (it is an OTP elsewhere).
        errorCode: response.body.code,
      };
      if (response.log.level === 'error') {
        this.logger.error(fields, 'request failed');
      } else {
        this.logger.warn(fields, 'request failed');
      }
    }

    // A streamed response that already started can't become an error body.
    if (reply.sent) return;

    void reply
      .status(response.status)
      .headers(response.headers)
      .type('application/json; charset=utf-8')
      .send({ ...response.body, requestId: request.id });
  }
}
