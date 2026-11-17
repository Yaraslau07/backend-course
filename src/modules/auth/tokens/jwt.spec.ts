import { createHmac, randomBytes } from 'node:crypto';

import {
  CLOCK_TOLERANCE_SECONDS,
  type JwtClaims,
  type JwtExpectations,
  signJwt,
  verifyJwt,
} from './jwt';

/** Spec 1.2 §1.3.3–1.3.6: HS256 only, exact claims, 30 s tolerance, the log categories. */
const SECRET = randomBytes(32).toString('base64url');
const OTHER = randomBytes(32).toString('base64url');
const NOW = 1_800_000_000;
const SUB = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';

const claims = (overrides: Partial<JwtClaims> = {}): JwtClaims => ({
  sub: SUB,
  iss: 'issuer',
  aud: 'audience',
  iat: NOW,
  exp: NOW + 900,
  token_use: 'access',
  ...overrides,
});

const expected = (
  overrides: Partial<JwtExpectations> = {},
): JwtExpectations => ({
  issuer: 'issuer',
  audience: 'audience',
  use: 'access',
  now: NOW,
  ...overrides,
});

const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

/** A token with any header and payload, signed correctly with `secret`. */
function forge(header: unknown, payload: unknown, secret = SECRET): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(input)
    .digest('base64url');
  return `${input}.${signature}`;
}

const HEADER = { alg: 'HS256', typ: 'JWT' };

describe('signJwt()', () => {
  it('produces a three-part HS256 token whose payload is exactly the claims', () => {
    const token = signJwt(claims(), SECRET);
    const [header, payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual(
      HEADER,
    );
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual(
      claims(),
    );
    expect(signature).toBe(
      createHmac('sha256', Buffer.from(SECRET, 'base64url'))
        .update(`${header}.${payload}`)
        .digest('base64url'),
    );
  });

  it('matches a token built independently (interoperable with any HS256 library)', () => {
    expect(signJwt(claims(), SECRET)).toBe(forge(HEADER, claims()));
  });
});

describe('verifyJwt()', () => {
  it('accepts its own token and returns the claims', () => {
    expect(verifyJwt(signJwt(claims(), SECRET), SECRET, expected())).toEqual({
      ok: true,
      claims: claims(),
    });
  });

  it.each([undefined, ''])('reports %p as missing', (token) => {
    expect(verifyJwt(token, SECRET, expected())).toEqual({
      ok: false,
      failure: 'missing',
    });
  });

  it.each([
    ['one part', 'abc'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['an empty signature', `${b64(HEADER)}.${b64(claims())}.`],
    ['non-base64url characters', `${b64(HEADER)}.${b64(claims())}.a+b/c=`],
    ['a header that is not JSON', forge('not json', claims())],
    ['a payload that is not JSON', forge(HEADER, 'not json')],
    ['a payload that is an array', forge(HEADER, [1, 2])],
    ['a header that is null', forge(null, claims())],
    ['a very long value', 'a'.repeat(9000)],
  ])('reports %s as malformed', (_name, token) => {
    expect(verifyJwt(token, SECRET, expected())).toEqual({
      ok: false,
      failure: 'malformed',
    });
  });

  it.each([
    ['alg none', { alg: 'none', typ: 'JWT' }],
    ['alg HS512', { alg: 'HS512', typ: 'JWT' }],
    ['alg RS256', { alg: 'RS256', typ: 'JWT' }],
    ['a missing alg', { typ: 'JWT' }],
    ['a lowercase alg', { alg: 'hs256', typ: 'JWT' }],
    ['a crit extension', { ...HEADER, crit: ['exp'] }],
  ])('refuses %s (HS256 only, no algorithm negotiation)', (_name, header) => {
    expect(verifyJwt(forge(header, claims()), SECRET, expected())).toEqual({
      ok: false,
      failure: 'malformed',
    });
  });

  it('refuses an unsigned "alg: none" token with an empty signature', () => {
    const token = `${b64({ alg: 'none' })}.${b64(claims())}.`;
    expect(verifyJwt(token, SECRET, expected()).ok).toBe(false);
  });

  it('reports a token signed with another key as a signature failure', () => {
    expect(verifyJwt(signJwt(claims(), OTHER), SECRET, expected())).toEqual({
      ok: false,
      failure: 'signature',
    });
  });

  it('reports a changed payload as a signature failure', () => {
    const [header, , signature] = signJwt(claims(), SECRET).split('.');
    const tampered = `${header}.${b64(claims({ sub: 'someone-else' }))}.${signature}`;
    expect(verifyJwt(tampered, SECRET, expected())).toEqual({
      ok: false,
      failure: 'signature',
    });
  });

  it('reports a truncated signature as a signature failure', () => {
    const token = signJwt(claims(), SECRET);
    expect(verifyJwt(token.slice(0, -4), SECRET, expected())).toEqual({
      ok: false,
      failure: 'signature',
    });
  });

  describe('expiry, with 30 s of tolerance', () => {
    it('accepts a token that expired less than 30 s ago', () => {
      const token = signJwt(
        claims({ iat: NOW - 900, exp: NOW - CLOCK_TOLERANCE_SECONDS + 1 }),
        SECRET,
      );
      expect(verifyJwt(token, SECRET, expected()).ok).toBe(true);
    });

    it('refuses a token that expired 30 s ago or more', () => {
      const token = signJwt(
        claims({ iat: NOW - 900, exp: NOW - CLOCK_TOLERANCE_SECONDS }),
        SECRET,
      );
      expect(verifyJwt(token, SECRET, expected())).toEqual({
        ok: false,
        failure: 'expired',
      });
    });

    it('accepts a token issued up to 30 s in the future (clock skew)', () => {
      const token = signJwt(
        claims({ iat: NOW + CLOCK_TOLERANCE_SECONDS }),
        SECRET,
      );
      expect(verifyJwt(token, SECRET, expected()).ok).toBe(true);
    });

    it('refuses a token issued more than 30 s in the future', () => {
      const token = signJwt(
        claims({ iat: NOW + CLOCK_TOLERANCE_SECONDS + 1 }),
        SECRET,
      );
      expect(verifyJwt(token, SECRET, expected())).toEqual({
        ok: false,
        failure: 'claims',
      });
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['another issuer', { iss: 'someone' }],
    ['another audience', { aud: 'someone' }],
    ['an audience array', { aud: ['audience'] }],
    ['an empty sub', { sub: '' }],
    ['a sub that is not a uuid', { sub: 'admin' }],
    ['a numeric sub', { sub: 42 }],
    ['a string iat', { iat: String(NOW) }],
    ['a fractional exp', { exp: NOW + 900.5 }],
    ['exp before iat', { exp: NOW - 1, iat: NOW }],
  ])('reports %s as a claims failure', (_name, overrides) => {
    const token = forge(HEADER, { ...claims(), ...overrides });
    expect(verifyJwt(token, SECRET, expected())).toEqual({
      ok: false,
      failure: 'claims',
    });
  });

  it.each(['sub', 'iss', 'aud', 'iat', 'exp'])(
    'reports a missing %s as a claims failure',
    (name) => {
      const payload: Record<string, unknown> = { ...claims() };
      delete payload[name];
      expect(verifyJwt(forge(HEADER, payload), SECRET, expected())).toEqual({
        ok: false,
        failure: 'claims',
      });
    },
  );

  it.each<[string, unknown]>([
    ['the other kind', 'refresh'],
    ['a missing token_use', undefined],
    ['an unknown token_use', 'id'],
  ])('reports %s as a token_use failure', (_name, use) => {
    const token = forge(HEADER, { ...claims(), token_use: use });
    expect(verifyJwt(token, SECRET, expected())).toEqual({
      ok: false,
      failure: 'token_use',
    });
  });
});
