import Joi from 'joi';
import ms from 'ms';
import type { StringValue } from 'ms';

import { AppConfig, CursorKey } from './config.types';

export const MIN_KEY_BYTES = 32;

/** Every standalone secret. Each must decode to >= 32 bytes and differ from all others. */
export const SECRET_KEY_NAMES = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'REGISTRATION_CHALLENGE_HMAC_KEY',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'EMAIL_CHANGE_HMAC_KEY',
  'DELETION_CHALLENGE_HMAC_KEY',
  'LOG_PSEUDONYM_HMAC_KEY',
] as const satisfies readonly (keyof AppConfig)[];

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const GENERATE_HINT = 'generate one with `npm run keys:generate`';

/** Decodes a base64url key; returns null when it is not valid key material. */
export function decodeKey(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < MIN_KEY_BYTES) return null;
  if (bytes.every((b) => b === bytes[0])) return null;
  return bytes;
}

/** A base64url secret that decodes to >= 32 bytes and isn't a trivial repeated byte. */
export const secretKey = () =>
  Joi.string()
    .required()
    .custom((value: string, helpers) =>
      decodeKey(value) ? value : helpers.error('secret.invalid'),
    )
    .messages({
      'secret.invalid': `{{#label}} must be base64url key material of at least ${MIN_KEY_BYTES} random bytes; ${GENERATE_HINT}`,
    });

/** A duration with a unit ("15m", "30d") inside [min, max]. A bare number is rejected: ms('15') is 15 milliseconds. */
export const duration = (min: StringValue, max: StringValue) =>
  Joi.string()
    .required()
    .custom((value: string, helpers) => {
      let parsed: number | undefined;
      try {
        parsed = /^\d+$/.test(value) ? undefined : ms(value as StringValue);
      } catch {
        parsed = undefined;
      }
      if (
        typeof parsed !== 'number' ||
        !Number.isFinite(parsed) ||
        parsed < ms(min) ||
        parsed > ms(max)
      ) {
        return helpers.error('duration.invalid');
      }
      return value;
    })
    .messages({
      'duration.invalid': `{{#label}} must be a duration with a unit (e.g. "15m") between ${min} and ${max}`,
    });

/** Comma-separated list of exact origins (scheme://host[:port]); no wildcard, path or trailing slash. */
export const originList = () =>
  Joi.string()
    .required()
    .custom((value: string, helpers) => {
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) return helpers.error('origins.invalid');
      for (const item of items) {
        let url: URL;
        try {
          url = new URL(item);
        } catch {
          return helpers.error('origins.invalid');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== item
        ) {
          return helpers.error('origins.invalid');
        }
      }
      return [...new Set(items)];
    })
    .messages({
      'origins.invalid':
        '{{#label}} must be a comma-separated list of exact origins like https://app.example.com',
    });

/** Comma-separated list of IP addresses. */
const parseIps = (value: string): string[] | null => {
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = Joi.string().ip({ cidr: 'forbidden' });
  return items.length === 0 || items.some((i) => ip.validate(i).error)
    ? null
    : items;
};

export const ipList = (defaultValue: string) =>
  Joi.string()
    // Joi does not run custom() on defaults, so the default is already the parsed form.
    .default(parseIps(defaultValue))
    .custom(
      (value: string, helpers) =>
        parseIps(value) ?? helpers.error('ips.invalid'),
    )
    .messages({
      'ips.invalid':
        '{{#label}} must be a comma-separated list of IP addresses',
    });

/** Key ring: "kid:key,kid:key". Kids are unique; every key passes `secretKey()` rules. */
export const cursorKeyRing = () =>
  Joi.string()
    .required()
    .custom((value: string, helpers) => {
      const ring: CursorKey[] = [];
      for (const entry of value.split(',').map((s) => s.trim())) {
        const sep = entry.indexOf(':');
        const kid = entry.slice(0, sep);
        const key = entry.slice(sep + 1);
        if (sep <= 0 || !KID.test(kid)) return helpers.error('ring.format');
        if (!decodeKey(key)) return helpers.error('ring.key', { kid });
        if (ring.some((k) => k.kid === kid))
          return helpers.error('ring.duplicateKid', { kid });
        ring.push({ kid, key });
      }
      return ring;
    })
    .messages({
      'ring.format': '{{#label}} must look like "kid1:key1,kid2:key2"',
      'ring.key': `{{#label}} key for kid "{{#kid}}" is not valid key material; ${GENERATE_HINT}`,
      'ring.duplicateKid': '{{#label}} repeats kid "{{#kid}}"',
    });

const method = () => Joi.string().valid('otp', 'magic_link').default('otp');

export const configSchema = Joi.object<AppConfig>({
  /* Server */
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().default(3007),
  TRUST_PROXY: Joi.boolean().default(false),
  PUBLIC_API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  FRONTEND_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  CORS_ORIGINS: originList(),
  COOKIE_SECURE: Joi.boolean().default(true),
  READINESS_ALLOWED_IPS: ipList('127.0.0.1,::1'),

  /* PostgreSQL */
  POSTGRES_HOST: Joi.string().hostname().required(),
  POSTGRES_PORT: Joi.number().port().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_LOGGING: Joi.boolean().default(false),
  POSTGRES_MIGRATIONS_RUN: Joi.boolean().default(false),

  /* JWT */
  JWT_ACCESS_SECRET: secretKey(),
  JWT_REFRESH_SECRET: secretKey(),
  JWT_ISSUER: Joi.string().trim().min(1).required(),
  JWT_AUDIENCE: Joi.string().trim().min(1).required(),

  /* Challenge keys */
  REGISTRATION_CHALLENGE_HMAC_KEY: secretKey(),
  LOGIN_CHALLENGE_HMAC_KEY: secretKey(),
  EMAIL_CHANGE_HMAC_KEY: secretKey(),
  DELETION_CHALLENGE_HMAC_KEY: secretKey(),

  /* Cursor / log */
  USER_LIST_CURSOR_ACTIVE_KEY_ID: Joi.string().pattern(KID).required(),
  USER_LIST_CURSOR_HMAC_KEYS: cursorKeyRing(),
  LOG_PSEUDONYM_HMAC_KEY: secretKey(),

  /* Flows */
  REGISTRATION_EMAIL_CONFIRMATION_ENABLED: Joi.boolean().default(false),
  REGISTRATION_EMAIL_CONFIRMATION_METHOD: method(),
  LOGIN_EMAIL_CONFIRMATION_ENABLED: Joi.boolean().default(false),
  LOGIN_EMAIL_CONFIRMATION_METHOD: method(),
  EMAIL_CHANGE_METHOD: method(),
  DELETION_CONFIRMATION_METHOD: method(),
  REGISTRATION_RATE_LIMIT_PER_HOUR: Joi.number()
    .integer()
    .min(1)
    .max(10_000)
    .default(10),
  RBAC_BOOTSTRAP_ADMIN_USER_ID: Joi.string().uuid().empty('').optional(),
  DELETION_WORKER_LEASE_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(300),

  /* SMTP */
  SMTP_HOST: Joi.string().hostname().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().empty('').optional(),
  SMTP_PASSWORD: Joi.string().empty('').optional(),
  MAIL_FROM: Joi.string().required(),
});

/** Rejects any two secrets with identical key material, naming the variables (never the values). */
export function assertDistinctKeys(config: AppConfig): void {
  const entries: [string, string][] = SECRET_KEY_NAMES.map((name) => [
    name,
    config[name],
  ]);
  for (const { kid, key } of config.USER_LIST_CURSOR_HMAC_KEYS) {
    entries.push([`USER_LIST_CURSOR_HMAC_KEYS[${kid}]`, key]);
  }

  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [name, value] of entries) {
    const fingerprint = Buffer.from(value, 'base64url').toString('hex');
    const previous = seen.get(fingerprint);
    if (previous) clashes.push(`${previous} = ${name}`);
    else seen.set(fingerprint, name);
  }
  if (clashes.length > 0) {
    throw new Error(
      `Config validation error: keys must all be different (${clashes.join('; ')})`,
    );
  }
}

/** Rules that span several variables. */
export function assertCrossFieldRules(config: AppConfig): void {
  const errors: string[] = [];

  if (
    !config.USER_LIST_CURSOR_HMAC_KEYS.some(
      (k) => k.kid === config.USER_LIST_CURSOR_ACTIVE_KEY_ID,
    )
  ) {
    errors.push(
      'USER_LIST_CURSOR_ACTIVE_KEY_ID is not present in USER_LIST_CURSOR_HMAC_KEYS',
    );
  }

  if (config.NODE_ENV === 'production') {
    if (!config.COOKIE_SECURE)
      errors.push('COOKIE_SECURE must be true in production');
    if (!config.PUBLIC_API_BASE_URL.startsWith('https://')) {
      errors.push('PUBLIC_API_BASE_URL must use https in production');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation error: ${errors.join('; ')}`);
  }
}

/**
 * The single entry point for config: Joi schema, then cross-field rules.
 * Used by `ConfigModule` and by `main.ts` (which needs TRUST_PROXY before Nest starts).
 */
export function validate(raw: Record<string, unknown>): AppConfig {
  const result = configSchema.validate(raw, {
    allowUnknown: true,
    stripUnknown: true,
    abortEarly: false,
  });
  const { error } = result;
  // Joi types `value` as any; the schema above is what makes it an AppConfig.
  const value = result.value as unknown as AppConfig;
  if (error) {
    throw new Error(
      `Config validation error: ${error.details.map((d) => d.message).join('; ')}`,
    );
  }
  assertDistinctKeys(value);
  assertCrossFieldRules(value);
  return value;
}
