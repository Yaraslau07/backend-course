import { Logger } from '@nestjs/common';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

import { checkCsrf, CsrfPolicy, csrfSettingsFrom } from './csrf';

const settings = csrfSettingsFrom({
  PUBLIC_API_BASE_URL: 'https://api.example.test',
  CORS_ORIGINS: ['https://app.example.test', 'http://localhost:5173'],
});

const req = (
  method: string,
  headers: Record<string, string | string[] | undefined> = {},
) => ({ method, headers });

const FRONTEND = 'https://app.example.test';

describe('csrfSettingsFrom()', () => {
  it('takes the API origin from PUBLIC_API_BASE_URL, dropping any path and default port', () => {
    expect(
      csrfSettingsFrom({
        PUBLIC_API_BASE_URL: 'https://api.example.test:443/v1/',
        CORS_ORIGINS: [],
      }).selfOrigin,
    ).toBe('https://api.example.test');
  });
});

describe('checkCsrf()', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])(
    '%s never changes state, so it passes from any origin',
    (method) => {
      expect(
        checkCsrf(req(method, { origin: 'https://evil.test' }), settings),
      ).toBeNull();
    },
  );

  describe.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s', (method) => {
    it('passes from an allowed origin with X-CSRF-Protection: 1', () => {
      expect(
        checkCsrf(
          req(method, { origin: FRONTEND, 'x-csrf-protection': '1' }),
          settings,
        ),
      ).toBeNull();
    });

    it('is rejected from an allowed origin without the header', () => {
      expect(checkCsrf(req(method, { origin: FRONTEND }), settings)).toBe(
        'header_missing',
      );
    });

    it.each(['0', 'true', '', ' 1', '1, 1'])(
      'is rejected when the header is %p instead of exactly "1"',
      (value) => {
        expect(
          checkCsrf(
            req(method, { origin: FRONTEND, 'x-csrf-protection': value }),
            settings,
          ),
        ).toBe('header_missing');
      },
    );

    it('is rejected from an origin not in CORS_ORIGINS, even with the header', () => {
      expect(
        checkCsrf(
          req(method, {
            origin: 'https://evil.test',
            'x-csrf-protection': '1',
          }),
          settings,
        ),
      ).toBe('origin_not_allowed');
    });

    it('is rejected from a same-site subdomain that is not listed (same-site is not enough)', () => {
      expect(
        checkCsrf(
          req(method, {
            origin: 'https://other.example.test',
            'x-csrf-protection': '1',
          }),
          settings,
        ),
      ).toBe('origin_not_allowed');
    });

    it.each([
      'null',
      'not a url',
      'https://app.example.test/path',
      'https://APP.example.test.',
    ])('is rejected for an opaque or malformed origin %p', (origin) => {
      expect(
        checkCsrf(req(method, { origin, 'x-csrf-protection': '1' }), settings),
      ).toBe('origin_not_allowed');
    });

    it('is rejected when several Origin headers are sent', () => {
      expect(
        checkCsrf(
          req(method, {
            origin: [FRONTEND, FRONTEND],
            'x-csrf-protection': '1',
          }),
          settings,
        ),
      ).toBe('origin_not_allowed');
    });

    it('passes from the API origin itself without the header (same-origin)', () => {
      expect(
        checkCsrf(
          req(method, { origin: 'https://api.example.test' }),
          settings,
        ),
      ).toBeNull();
    });

    it('passes without Origin for a client that is not a browser', () => {
      expect(checkCsrf(req(method), settings)).toBeNull();
      expect(
        checkCsrf(req(method, { 'sec-fetch-site': 'none' }), settings),
      ).toBeNull();
      expect(
        checkCsrf(req(method, { 'sec-fetch-site': 'same-origin' }), settings),
      ).toBeNull();
    });

    it.each(['cross-site', 'same-site'])(
      'is rejected without Origin when the browser says the request is %s',
      (site) => {
        expect(
          checkCsrf(req(method, { 'sec-fetch-site': site }), settings),
        ).toBe('origin_missing');
      },
    );
  });
});

describe('CsrfPolicy', () => {
  const config = {
    get: (key: string) =>
      ({
        PUBLIC_API_BASE_URL: 'https://api.example.test',
        CORS_ORIGINS: [FRONTEND],
      })[key],
  } as unknown as ConfigService;
  const policy = new CsrfPolicy(config);
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing for an accepted request', () => {
    expect(() =>
      policy.assert(
        req('POST', { origin: FRONTEND, 'x-csrf-protection': '1' }),
        'C.m',
      ),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws 403 csrf_rejected and logs the reason, never the origin', () => {
    let thrown: unknown;
    try {
      policy.assert(req('POST', { origin: 'https://evil.test' }), 'C.m');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).code).toBe('csrf_rejected');
    expect(warn).toHaveBeenCalledWith(
      {
        category: 'csrf_rejected',
        reason: 'origin_not_allowed',
        handler: 'C.m',
      },
      'cross-origin write rejected',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('evil');
  });
});
