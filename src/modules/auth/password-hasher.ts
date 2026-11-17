import { Injectable } from '@nestjs/common';
import { type Algorithm, hash, type Options, verify } from '@node-rs/argon2';

export const PASSWORD_MIN_LENGTH = 8;
/**
 * Argon2 has no length cut-off (unlike bcrypt's 72 bytes), but an unbounded input is unbounded
 * work per request. Longer passwords are rejected by validation, never truncated (D40).
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * argon2id with the OWASP minimum: 19 MiB, 2 passes, 1 lane. A fresh random salt per hash; the
 * salt and parameters are part of the stored string. `Algorithm` is a const enum the package
 * doesn't export at runtime, hence the literal.
 */
export const ARGON2_OPTIONS: Options = {
  algorithm: 2 as Algorithm, // Argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /** False for a wrong password and for a stored value that isn't a valid hash. */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }
}
