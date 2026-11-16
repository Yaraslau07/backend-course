import { createHmac } from 'node:crypto';

const DOMAIN = 'log-pseudonym:v1';

/**
 * Irreversible, stable pseudonym for correlating events in logs without recording the value
 * (e.g. an unknown email on login). Keyed with LOG_PSEUDONYM_HMAC_KEY, which is used for nothing else.
 */
export function pseudonymize(value: string, base64urlKey: string): string {
  return createHmac('sha256', Buffer.from(base64urlKey, 'base64url'))
    .update(`${DOMAIN}\0${value}`)
    .digest('base64url')
    .slice(0, 22);
}
