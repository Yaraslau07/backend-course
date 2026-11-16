import {
  formatToken,
  generateMagicSecret,
  generateOtp,
  hashSecret,
  parseToken,
  secretsEqual,
} from './challenge-secrets';

const KEY = Buffer.alloc(32, 5).toString('base64url');
const OTHER_KEY = Buffer.alloc(32, 6).toString('base64url');
const ID = '3f2b8f0e-6a1d-4c8e-9a51-0d7f6b2c1e44';

describe('generateOtp()', () => {
  it('is exactly six digits, leading zeros kept', () => {
    for (let i = 0; i < 2000; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('covers the whole range rather than a biased part of it', () => {
    const firstDigits = new Set(
      Array.from({ length: 2000 }, () => generateOtp()[0]),
    );
    expect(firstDigits.size).toBe(10);
  });
});

describe('generateMagicSecret()', () => {
  it('is 32 random bytes in base64url', () => {
    const secret = generateMagicSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(generateMagicSecret()).not.toBe(secret);
  });
});

describe('hashSecret()', () => {
  it('is a 32-byte HMAC, stable for the same key, scenario and secret', () => {
    const hash = hashSecret(KEY, 'login', '048213');

    expect(hash).toHaveLength(32);
    expect(hashSecret(KEY, 'login', '048213').equals(hash)).toBe(true);
  });

  it('differs per key, per scenario and per secret', () => {
    const base = hashSecret(KEY, 'login', '048213');

    expect(hashSecret(OTHER_KEY, 'login', '048213').equals(base)).toBe(false);
    expect(hashSecret(KEY, 'deletion', '048213').equals(base)).toBe(false);
    expect(hashSecret(KEY, 'login', '048214').equals(base)).toBe(false);
  });
});

describe('secretsEqual()', () => {
  it('compares two hashes', () => {
    const a = hashSecret(KEY, 'login', '1');
    expect(secretsEqual(a, hashSecret(KEY, 'login', '1'))).toBe(true);
    expect(secretsEqual(a, hashSecret(KEY, 'login', '2'))).toBe(false);
  });

  it('is false, not an exception, for buffers of different lengths', () => {
    expect(secretsEqual(Buffer.alloc(32), Buffer.alloc(31))).toBe(false);
  });
});

describe('formatToken() / parseToken()', () => {
  const secret = generateMagicSecret();

  it('uses attemptId.secret when the scenario puts the id in the token', () => {
    const token = formatToken('login', ID, secret);

    expect(token).toBe(`${ID}.${secret}`);
    expect(parseToken('login', token)).toEqual({ challengeId: ID, secret });
  });

  it('uses the secret alone for registration (found by its HMAC)', () => {
    const token = formatToken('registration', ID, secret);

    expect(token).toBe(secret);
    expect(parseToken('registration', token)).toEqual({ secret });
  });

  it.each([
    ['login', ''],
    ['login', secret],
    ['login', `not-a-uuid.${secret}`],
    ['login', `${ID}.short`],
    ['login', `${ID}.${secret}.extra`],
    ['login', `${ID.toUpperCase()}.${secret}`],
    ['registration', `${ID}.${secret}`],
    ['registration', 'x'.repeat(43) + '='],
    ['deletion', `${ID}.${secret}!`],
  ] as const)('rejects a malformed %s token %p', (scenario, token) => {
    expect(parseToken(scenario, token)).toBeNull();
  });
});
