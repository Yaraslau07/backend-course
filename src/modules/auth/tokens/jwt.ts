/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
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

export function signJwt(_claims: JwtClaims, _base64urlSecret: string): string {
  throw new Error('not implemented');
}

export function verifyJwt(
  _token: string | undefined,
  _base64urlSecret: string,
  _expected: JwtExpectations,
): JwtVerification {
  throw new Error('not implemented');
}
