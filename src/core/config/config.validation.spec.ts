import { randomBytes } from 'node:crypto';
import Joi from 'joi';

import {
  assertCrossFieldRules,
  assertDistinctKeys,
  cursorKeyRing,
  decodeKey,
  duration,
  ipList,
  originList,
  secretKey,
  validate,
} from './config.validation';

const key = () => randomBytes(32).toString('base64url');

const validEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  PUBLIC_API_BASE_URL: 'http://localhost:3007',
  FRONTEND_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'postgres',
  POSTGRES_DB: 'app',
  JWT_ACCESS_SECRET: key(),
  JWT_REFRESH_SECRET: key(),
  JWT_ISSUER: 'backend-course',
  JWT_AUDIENCE: 'backend-course-api',
  REGISTRATION_CHALLENGE_HMAC_KEY: key(),
  LOGIN_CHALLENGE_HMAC_KEY: key(),
  EMAIL_CHANGE_HMAC_KEY: key(),
  DELETION_CHALLENGE_HMAC_KEY: key(),
  LOG_PSEUDONYM_HMAC_KEY: key(),
  USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
  USER_LIST_CURSOR_HMAC_KEYS: `k1:${key()}`,
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Backend Course <no-reply@example.com>',
});

const check = (schema: Joi.Schema, value: unknown) => schema.validate(value);

describe('validate()', () => {
  it('accepts a complete env and applies defaults and transforms', () => {
    const config = validate(validEnv());
    expect(config.PORT).toBe(3007);
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(config.READINESS_ALLOWED_IPS).toEqual(['127.0.0.1', '::1']);
    expect(config.USER_LIST_CURSOR_HMAC_KEYS).toHaveLength(1);
    expect(config.LOGIN_EMAIL_CONFIRMATION_METHOD).toBe('otp');
    expect(config.DELETION_WORKER_LEASE_SECONDS).toBe(300);
    expect(config.RBAC_BOOTSTRAP_ADMIN_USER_ID).toBeUndefined();
  });

  it('strips unrelated process env variables', () => {
    const config = validate({
      ...validEnv(),
      HOME: '/root',
    }) as unknown as Record<string, unknown>;
    expect(config.HOME).toBeUndefined();
  });

  it('reports every missing key at once, without values', () => {
    const env = validEnv();
    delete (env as Partial<typeof env>).JWT_ACCESS_SECRET;
    delete (env as Partial<typeof env>).LOGIN_CHALLENGE_HMAC_KEY;
    expect(() => validate(env)).toThrow(
      /JWT_ACCESS_SECRET.*LOGIN_CHALLENGE_HMAC_KEY/,
    );
  });

  it('rejects a reused key and names both variables but not the value', () => {
    const env = validEnv();
    env.JWT_REFRESH_SECRET = env.JWT_ACCESS_SECRET;
    let message = '';
    try {
      validate(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('JWT_ACCESS_SECRET = JWT_REFRESH_SECRET');
    expect(message).not.toContain(env.JWT_ACCESS_SECRET);
  });

  it('rejects an active kid that is missing from the ring', () => {
    expect(() =>
      validate({ ...validEnv(), USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k9' }),
    ).toThrow(/USER_LIST_CURSOR_ACTIVE_KEY_ID is not present/);
  });

  it('enforces production rules', () => {
    const prod = {
      ...validEnv(),
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
    };
    expect(() => validate(prod)).toThrow(
      /COOKIE_SECURE must be true in production/,
    );
    expect(() => validate(prod)).toThrow(/PUBLIC_API_BASE_URL must use https/);
    expect(() =>
      validate({
        ...prod,
        COOKIE_SECURE: 'true',
        PUBLIC_API_BASE_URL: 'https://api.example.com',
      }),
    ).not.toThrow();
  });

  it('allows COOKIE_SECURE=false outside production', () => {
    expect(
      validate({ ...validEnv(), COOKIE_SECURE: 'false' }).COOKIE_SECURE,
    ).toBe(false);
  });

  it('treats an empty bootstrap admin id as absent and rejects a non-uuid', () => {
    expect(
      validate({ ...validEnv(), RBAC_BOOTSTRAP_ADMIN_USER_ID: '' })
        .RBAC_BOOTSTRAP_ADMIN_USER_ID,
    ).toBeUndefined();
    expect(() =>
      validate({ ...validEnv(), RBAC_BOOTSTRAP_ADMIN_USER_ID: 'admin' }),
    ).toThrow(/RBAC_BOOTSTRAP_ADMIN_USER_ID/);
  });
});

describe('decodeKey() / secretKey()', () => {
  it('accepts 32 random bytes', () => {
    expect(decodeKey(key())).toHaveLength(32);
    expect(check(secretKey(), key()).error).toBeUndefined();
  });

  it.each([
    ['too short', randomBytes(31).toString('base64url')],
    ['standard base64 alphabet', `${key()}+/`],
    ['padding', `${key()}=`],
    ['repeated byte', Buffer.alloc(32, 7).toString('base64url')],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(decodeKey(value)).toBeNull();
    expect(check(secretKey(), value).error).toBeDefined();
  });
});

describe('duration()', () => {
  const schema = duration('1m', '1h');

  it('accepts values with a unit inside the range', () => {
    expect(check(schema, '15m').error).toBeUndefined();
  });

  it.each(['15', '30s', '2h', 'soon'])('rejects %s', (value) => {
    expect(check(schema, value).error?.message).toMatch(/between 1m and 1h/);
  });
});

describe('originList()', () => {
  it('splits, trims and de-duplicates exact origins', () => {
    expect(
      check(
        originList(),
        'https://a.example.com, http://localhost:5173,https://a.example.com',
      ).value,
    ).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });

  it.each([
    '*',
    'https://a.example.com/',
    'https://a.example.com/path',
    'ftp://a.example.com',
    'not a url',
    ' , ',
  ])('rejects %s', (value) => {
    expect(check(originList(), value).error).toBeDefined();
  });
});

describe('ipList()', () => {
  it('uses the default and parses lists', () => {
    expect(check(ipList('127.0.0.1'), undefined).value).toEqual(['127.0.0.1']);
    expect(check(ipList('127.0.0.1'), '10.0.0.1, ::1').value).toEqual([
      '10.0.0.1',
      '::1',
    ]);
  });

  it.each(['localhost', '10.0.0.0/8', ','])('rejects %s', (value) => {
    expect(check(ipList('127.0.0.1'), value).error).toBeDefined();
  });
});

describe('cursorKeyRing()', () => {
  it('parses several keys', () => {
    const ring = check(cursorKeyRing(), `a:${key()},b:${key()}`).value as {
      kid: string;
    }[];
    expect(ring.map((k) => k.kid)).toEqual(['a', 'b']);
  });

  it.each([
    ['missing separator', key()],
    ['empty kid', `:${key()}`],
    ['bad kid', `a b:${key()}`],
    ['weak key', 'a:short'],
  ])('rejects %s', (_label, value) => {
    expect(check(cursorKeyRing(), value).error).toBeDefined();
  });

  it('rejects a duplicate kid', () => {
    expect(
      check(cursorKeyRing(), `a:${key()},a:${key()}`).error?.message,
    ).toMatch(/repeats kid "a"/);
  });
});

describe('assertDistinctKeys()', () => {
  it('detects a cursor ring key reused as another secret', () => {
    const config = validate(validEnv());
    config.USER_LIST_CURSOR_HMAC_KEYS[0].key = config.LOG_PSEUDONYM_HMAC_KEY;
    expect(() => assertDistinctKeys(config)).toThrow(
      /LOG_PSEUDONYM_HMAC_KEY = USER_LIST_CURSOR_HMAC_KEYS\[k1\]/,
    );
  });
});

describe('assertCrossFieldRules()', () => {
  it('passes for a valid config', () => {
    expect(() => assertCrossFieldRules(validate(validEnv()))).not.toThrow();
  });
});
