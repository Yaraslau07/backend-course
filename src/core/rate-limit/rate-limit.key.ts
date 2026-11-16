import { createHmac } from 'node:crypto';

const DOMAIN = 'rate-limit:v1';

/**
 * The stored counter key: an HMAC of the policy and the key parts (IP, email, user id), so the
 * table never holds a raw IP or email (D31). Parts are JSON-encoded, so `['a|b', 'c']` and
 * `['a', 'b|c']` can't collide.
 */
export function rateLimitKey(
  base64urlSecret: string,
  policy: string,
  parts: string[],
): string {
  return createHmac('sha256', Buffer.from(base64urlSecret, 'base64url'))
    .update(`${DOMAIN}\0${policy}\0${JSON.stringify(parts)}`)
    .digest('hex');
}
