import { Logger, type ArgumentsHost } from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app.exception';

function hostFor(sent = false) {
  const reply = {
    sent,
    status: jest.fn().mockReturnThis(),
    headers: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'request-1' }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the envelope with the request id, headers and JSON content type', () => {
    const { host, reply } = hostFor();

    filter.catch(
      new AppException('too_many_requests', { retryAfterSeconds: 5 }),
      host,
    );

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.headers).toHaveBeenCalledWith({ 'Retry-After': '5' });
    expect(reply.type).toHaveBeenCalledWith('application/json; charset=utf-8');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 429,
        code: 'too_many_requests',
        retryAfterSeconds: 5,
        requestId: 'request-1',
      }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an unexpected error at error level with the request id and error code', () => {
    const { host } = hostFor();

    filter.catch(new Error('boom'), host);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        statusCode: 500,
        errorCode: 'internal_error',
        errorType: 'Error',
      }),
      'request failed',
    );
  });

  it('logs a unique violation at warn level', () => {
    const { host } = hostFor();
    const unique = Object.assign(new Error('dup'), { code: '23505' });

    filter.catch(unique, host);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, errorCode: 'conflict' }),
      'request failed',
    );
  });

  it('logs but does not write when the response has already been sent', () => {
    const { host, reply } = hostFor(true);

    filter.catch(new Error('boom'), host);

    expect(error).toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
