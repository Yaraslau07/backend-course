// Stub: filled in by the implementation commit.
export const ERROR_CATALOGUE = {} as Record<
  | 'bad_request'
  | 'validation_failed'
  | 'invalid_json'
  | 'invalid_cursor'
  | 'invalid_credentials'
  | 'invalid_session'
  | 'forbidden'
  | 'permission_denied'
  | 'ownership_denied'
  | 'csrf_rejected'
  | 'self_confirmation_required'
  | 'not_found'
  | 'conflict'
  | 'file_not_ready'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'too_many_requests'
  | 'internal_error'
  | 'service_unavailable'
  | 'authorization_unavailable'
  | 'gateway_timeout',
  { status: number; message: string }
>;
export type ErrorCode = keyof typeof ERROR_CATALOGUE;
