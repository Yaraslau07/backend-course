import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { serializeRequest, serializeResponse } from './logging.module';
import { genReqId } from './request-id';
import { pseudonymize } from './pseudonymize';

describe('genReqId()', () => {
  const req = (incoming?: string) =>
    ({ headers: { 'x-request-id': incoming } }) as unknown as IncomingMessage;

  it('reuses an incoming UUID (lower-cased)', () => {
    const id = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';
    expect(genReqId(req(id.toUpperCase()))).toBe(id);
  });

  it.each([undefined, 'not-a-uuid', 'line\nbreak'])(
    'replaces %p with a fresh UUID',
    (incoming) => {
      const id = genReqId(req(incoming));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe(incoming);
    },
  );
});

describe('serializers', () => {
  it('log method and path, never the query string or headers', () => {
    const req = {
      id: 'r1',
      method: 'GET',
      url: '/admin/users?q=secret&cursor=abc',
      headers: { cookie: 'access_token=x' },
    } as unknown as IncomingMessage;
    expect(serializeRequest(req)).toEqual({
      id: 'r1',
      method: 'GET',
      path: '/admin/users',
    });
    expect(serializeRequest({ method: 'GET' } as IncomingMessage).path).toBe(
      '',
    );
    expect(serializeResponse({ statusCode: 204 } as ServerResponse)).toEqual({
      statusCode: 204,
    });
  });
});

describe('pseudonymize()', () => {
  const key = randomBytes(32).toString('base64url');

  it('is stable for one key and differs across keys and values', () => {
    expect(pseudonymize('a@example.com', key)).toBe(
      pseudonymize('a@example.com', key),
    );
    expect(pseudonymize('a@example.com', key)).not.toBe(
      pseudonymize('b@example.com', key),
    );
    expect(pseudonymize('a@example.com', key)).not.toBe(
      pseudonymize('a@example.com', randomBytes(32).toString('base64url')),
    );
  });

  it('does not contain the input', () => {
    expect(pseudonymize('a@example.com', key)).not.toContain('example');
  });
});
