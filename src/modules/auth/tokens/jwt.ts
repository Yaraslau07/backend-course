import { createHmac, timingSafeEqual } from 'node:crypto';

/** Spec 1.2 §1.3.3: the two kinds of token, told apart by the `token_use` claim. */
export type TokenUse = 'access' | 'refresh';

/**
 * Why a token was refused, as the spec's log categories (spec 1.2 §1.5). Clients always get the
 * one `401 invalid_session`; only the log says which check failed.
 */
export type JwtFailure =
  | 'missing'
  | 'malformed'
  | 'signature'
  | 'expired'
  | 'claims'
  | 'token_use';

/** Exactly the claims of spec 1.2 §1.3.3: no `jti`, roles, email or other personal data. */
export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  token_use: TokenUse;
}

export interface JwtExpectations {
  issuer: string;
  audience: string;
  use: TokenUse;
  /** Seconds since the epoch. */
  now: number;
}

export type JwtVerification =
  | { ok: true; claims: JwtClaims }
  | { ok: false; failure: JwtFailure };

/** "A permissible clock discrepancy of no more than 30 seconds" (spec 1.2 §1.3.4, §1.3.6). */
export const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * The only header we sign and the only one we accept (D42). Comparing the decoded header to it
 * rules out `alg: none`, other algorithms, `kid`/`jku` lookups and `crit` extensions in one step:
 * there is no algorithm negotiation at all.
 */
const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER)).toString(
  'base64url',
);

/** Our tokens are ~250 characters; anything far longer isn't ours and isn't worth parsing. */
const MAX_TOKEN_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hmac(input: string, base64urlSecret: string): string {
  return createHmac('sha256', Buffer.from(base64urlSecret, 'base64url'))
    .update(input)
    .digest('base64url');
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** HS256 over `header.payload` with the token kind's own key (spec 1.2 §1.3.3). */
export function signJwt(claims: JwtClaims, base64urlSecret: string): string {
  const input = `${ENCODED_HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${input}.${hmac(input, base64urlSecret)}`;
}

/**
 * Checks, in this order: present → three base64url parts with our exact header and a JSON object
 * payload (malformed) → signature in constant time → claim types, issuer and audience (claims) →
 * expiry with 30 s tolerance (expired) → `token_use` (token_use). Nothing in the payload is
 * looked at before the signature has been verified.
 */
export function verifyJwt(
  token: string | undefined,
  base64urlSecret: string,
  expected: JwtExpectations,
): JwtVerification {
  const fail = (failure: JwtFailure): JwtVerification => ({
    ok: false,
    failure,
  });

  if (token === undefined || token.length === 0) return fail('missing');
  if (token.length > MAX_TOKEN_LENGTH) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
    return fail('malformed');
  }
  const [header, payload, signature] = parts;

  const decodedHeader = decodeJson(header);
  if (
    !isObject(decodedHeader) ||
    Object.keys(decodedHeader).length !== 2 ||
    decodedHeader.alg !== HEADER.alg ||
    decodedHeader.typ !== HEADER.typ
  ) {
    return fail('malformed');
  }

  // Compare the base64url text, not decoded bytes: a non-canonical encoding of the right
  // signature is a different token, so it is refused too.
  const wanted = Buffer.from(hmac(`${header}.${payload}`, base64urlSecret));
  const given = Buffer.from(signature);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return fail('signature');
  }

  const claims = decodeJson(payload);
  if (!isObject(claims)) return fail('malformed');

  const { sub, iss, aud, iat, exp } = claims;
  if (
    typeof sub !== 'string' ||
    !UUID.test(sub) ||
    iss !== expected.issuer ||
    aud !== expected.audience ||
    !isTime(iat) ||
    !isTime(exp) ||
    exp <= iat ||
    iat > expected.now + CLOCK_TOLERANCE_SECONDS
  ) {
    return fail('claims');
  }
  if (exp <= expected.now - CLOCK_TOLERANCE_SECONDS) return fail('expired');
  if (claims.token_use !== expected.use) return fail('token_use');

  return {
    ok: true,
    claims: { sub, iss, aud, iat, exp, token_use: expected.use },
  };
}
