import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type RoutedMessage,
  serializeRequest,
  serializeResponse,
  withRoute,
} from './logging.module';
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
  it('bind only the id and method: never the concrete path, query string or headers', () => {
    const req = {
      id: 'r1',
      method: 'GET',
      url: '/users/3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44?q=secret&cursor=abc',
      headers: { cookie: 'access_token=x' },
    } as unknown as IncomingMessage;

    expect(serializeRequest(req)).toEqual({ id: 'r1', method: 'GET' });
    expect(serializeResponse({ statusCode: 204 } as ServerResponse)).toEqual({
      statusCode: 204,
    });
  });

  it('add the matched route pattern to the completion line (spec 1.3 §1.5: no target id before it may be read)', () => {
    const routed = { routePattern: '/users/:userId' } as RoutedMessage;

    expect(withRoute(routed, { responseTime: 3 })).toEqual({
      responseTime: 3,
      route: '/users/:userId',
    });
    // An unmatched URL could be anything, so it isn't logged at all.
    expect(withRoute({} as RoutedMessage, {})).toEqual({ route: null });
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
