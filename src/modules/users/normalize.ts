/** Spec 1.0: an email is compared and stored trimmed and lowercased; `+tag` is kept. */
export const EMAIL_MAX_LENGTH = 254;

/** Trim and lowercase a string; anything else is returned as is, so validation can report it. */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
