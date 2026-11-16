#!/usr/bin/env node
// Prints a fresh block of secret keys for .env. Every key is 32 random bytes, base64url.
// The app never generates keys itself (the spec forbids per-launch random keys).
import { randomBytes } from 'node:crypto';

const key = () => randomBytes(32).toString('base64url');

const names = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'REGISTRATION_CHALLENGE_HMAC_KEY',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'EMAIL_CHANGE_HMAC_KEY',
  'DELETION_CHALLENGE_HMAC_KEY',
  'LOG_PSEUDONYM_HMAC_KEY',
];

const lines = names.map((name) => `${name}=${key()}`);
const kid = `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
lines.push(`USER_LIST_CURSOR_ACTIVE_KEY_ID=${kid}`);
lines.push(`USER_LIST_CURSOR_HMAC_KEYS=${kid}:${key()}`);

process.stdout.write(lines.join('\n') + '\n');
