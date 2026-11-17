import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { normalizeEmail } from '@/modules/users/normalize';

import { RegisterDto } from './dto/register.dto';
import { PASSWORD_MAX_LENGTH, PasswordHasher } from './password-hasher';

/** The fields that failed, with their rule names, as the error envelope reports them. */
function failures(body: unknown): Record<string, string[]> {
  const dto = plainToInstance(RegisterDto, body);
  return Object.fromEntries(
    validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
      (e) => [e.property, Object.keys(e.constraints ?? {})],
    ),
  );
}

describe('normalizeEmail()', () => {
  it('trims and lowercases, keeping +tags', () => {
    expect(normalizeEmail('  User+Tag@Example.COM ')).toBe(
      'user+tag@example.com',
    );
  });

  it('leaves non-strings alone, so validation reports them', () => {
    expect(normalizeEmail(42)).toBe(42);
    expect(normalizeEmail(undefined)).toBeUndefined();
  });
});

describe('RegisterDto', () => {
  const valid = { email: 'new@example.com', password: 'correct horse 1' };

  it('accepts a valid body and normalizes the email', () => {
    const dto = plainToInstance(RegisterDto, {
      ...valid,
      email: ' New@Example.com ',
    });

    expect(validateSync(dto)).toEqual([]);
    expect(dto.email).toBe('new@example.com');
  });

  it('never trims or changes the password', () => {
    const dto = plainToInstance(RegisterDto, {
      ...valid,
      password: '  spaced 1  ',
    });

    expect(dto.password).toBe('  spaced 1  ');
  });

  it.each([
    ['not an email', { email: 'not-an-email' }, 'isEmail'],
    ['missing', { email: undefined }, 'isEmail'],
    ['not a string', { email: 42 }, 'isEmail'],
    [
      'longer than 254 characters',
      { email: `${'a'.repeat(243)}@example.com` },
      'maxLength',
    ],
  ])('rejects an email that is %s', (_name, override, rule) => {
    expect(failures({ ...valid, ...override }).email).toContain(rule);
  });

  it.each([
    ['shorter than 8 characters', 'abc1234', 'passwordLength'],
    ['without a letter', '12345678', 'passwordHasLetter'],
    ['without a digit', 'abcdefgh', 'passwordHasDigit'],
    [
      `longer than ${PASSWORD_MAX_LENGTH} characters`,
      `a1${'x'.repeat(PASSWORD_MAX_LENGTH - 1)}`,
      'passwordLength',
    ],
    ['not a string', 12345678, 'isString'],
  ])('rejects a password %s', (_name, password, rule) => {
    expect(failures({ ...valid, password }).password).toContain(rule);
  });

  it('accepts letters of any alphabet and counts characters, not bytes', () => {
    expect(failures({ ...valid, password: 'пароль12' })).toEqual({});
    // 8 characters, 4 of them outside the BMP (2 UTF-16 units each).
    expect(failures({ ...valid, password: '😀😀😀😀ab12' })).toEqual({});
    expect(
      failures({
        ...valid,
        password: `a1${'😀'.repeat(PASSWORD_MAX_LENGTH - 2)}`,
      }),
    ).toEqual({});
  });

  it('rejects unknown fields', () => {
    expect(failures({ ...valid, status: 'active' })).toEqual({
      status: ['whitelistValidation'],
    });
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('produces an argon2id hash with its parameters and salt in the string', async () => {
    const hash = await hasher.hash('correct horse 1');

    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
    );
    expect(hash).not.toContain('correct horse');
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same password 1')).not.toBe(
      await hasher.hash('same password 1'),
    );
  });

  it('verifies exactly the password, outer spaces included', async () => {
    const hash = await hasher.hash('  spaced 1  ');

    expect(await hasher.verify(hash, '  spaced 1  ')).toBe(true);
    expect(await hasher.verify(hash, 'spaced 1')).toBe(false);
  });

  it('does not cut long passwords: a change at the last character matters', async () => {
    const long = `a1${'x'.repeat(PASSWORD_MAX_LENGTH - 2)}`;
    const hash = await hasher.hash(long);

    expect(await hasher.verify(hash, `${long.slice(0, -1)}y`)).toBe(false);
  });

  it('answers false, not an error, for a malformed stored hash', async () => {
    expect(await hasher.verify('not-a-hash', 'whatever 1')).toBe(false);
  });
});
