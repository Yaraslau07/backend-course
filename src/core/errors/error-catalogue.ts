/**
 * Every error code the API can return, with its HTTP status and the one message clients see.
 * Messages are fixed text: they never include request values, library messages or internal names.
 * A feature that needs a new code adds it here (and to docs/invariants.md if it is cross-cutting).
 */
export const ERROR_CATALOGUE = {
  /* 400 */
  bad_request: { status: 400, message: 'The request is invalid.' },
  validation_failed: { status: 400, message: 'The request failed validation.' },
  invalid_json: { status: 400, message: 'The request body is not valid JSON.' },
  invalid_cursor: { status: 400, message: 'The cursor is invalid.' },
  invalid_challenge: {
    status: 400,
    message: 'The code or link is invalid or has expired.',
  },

  /* 401: one code per kind, never saying which check failed */
  invalid_credentials: { status: 401, message: 'Invalid email or password.' },
  invalid_session: {
    status: 401,
    message: 'The session is missing or invalid.',
  },

  /* 403 */
  forbidden: { status: 403, message: 'The request is not allowed.' },
  permission_denied: {
    status: 403,
    message: 'You do not have permission for this operation.',
  },
  ownership_denied: {
    status: 403,
    message: 'You do not have access to this resource.',
  },
  csrf_rejected: { status: 403, message: 'The request origin is not allowed.' },
  self_confirmation_required: {
    status: 403,
    message: 'Your own account can only be deleted through email confirmation.',
  },

  /* 404, 409, 413, 415, 429 */
  not_found: { status: 404, message: 'The resource was not found.' },
  method_not_allowed: {
    status: 405,
    message: 'The method is not allowed for this resource.',
  },
  request_timeout: { status: 408, message: 'The request took too long.' },
  conflict: {
    status: 409,
    message: 'The request conflicts with the current state.',
  },
  file_not_ready: { status: 409, message: 'The file is not ready yet.' },
  challenge_conflict: {
    status: 409,
    message: 'This confirmation is no longer valid.',
  },
  payload_too_large: { status: 413, message: 'The request body is too large.' },
  unsupported_media_type: {
    status: 415,
    message: 'The content type is not supported.',
  },
  unprocessable_entity: {
    status: 422,
    message: 'The request could not be processed.',
  },
  attempts_exhausted: {
    status: 429,
    message: 'Too many wrong codes. Start again.',
  },
  resend_cooldown: {
    status: 429,
    message: 'Wait before asking for another email.',
  },
  too_many_requests: {
    status: 429,
    message: 'Too many requests. Try again later.',
  },

  /* 5xx */
  internal_error: { status: 500, message: 'An unexpected error occurred.' },
  service_unavailable: {
    status: 503,
    message: 'A required service is unavailable. Try again later.',
  },
  authorization_unavailable: {
    status: 503,
    message: 'Authorization is temporarily unavailable. Try again later.',
  },
  gateway_timeout: { status: 504, message: 'The operation timed out.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

/** The code a plain HttpException (Nest's own, a library's) is reported as. */
export const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  // Any session failure is the single invalid_session (spec 1.2); a stray 401 is no different.
  401: 'invalid_session',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'request_timeout',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal_error',
  503: 'service_unavailable',
  504: 'gateway_timeout',
};
