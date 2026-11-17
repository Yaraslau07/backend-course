import { isEmail } from 'class-validator';

import { AppException } from '@/core/errors/app.exception';
import {
  parseToken,
  isChallengeId,
} from '@/modules/challenges/challenge-secrets';

export interface ProfilePatch {
  displayName?: string | null;
  email?: string;
  status?: 'active' | 'blocked';
}

function bad(): never {
  throw new AppException('bad_request');
}
export function objectInput(
  raw: unknown,
  fields: string[],
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const value = raw as Record<string, unknown>;
  if (
    !Object.keys(value).length ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    bad();
  return value;
}
export function patchFields(raw: unknown): Record<string, unknown> {
  return objectInput(raw, ['displayName', 'email', 'status']);
}
export function normalizedEmail(value: unknown): string {
  if (typeof value !== 'string') bad();
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !isEmail(email)) bad();
  return email;
}
export function normalizePatch(raw: Record<string, unknown>): ProfilePatch {
  const result: ProfilePatch = {};
  if (Object.hasOwn(raw, 'displayName')) {
    if (raw.displayName === null) result.displayName = null;
    else {
      if (typeof raw.displayName !== 'string') bad();
      const name = raw.displayName.trim().normalize('NFC');
      if (
        [...name].length < 1 ||
        [...name].length > 80 ||
        [...name].some(
          (c) =>
            c.codePointAt(0)! < 32 ||
            (c.codePointAt(0)! >= 127 && c.codePointAt(0)! <= 159),
        )
      )
        bad();
      result.displayName = name;
    }
  }
  if (Object.hasOwn(raw, 'email')) result.email = normalizedEmail(raw.email);
  if (Object.hasOwn(raw, 'status')) {
    if (raw.status !== 'active' && raw.status !== 'blocked') bad();
    result.status = raw.status;
  }
  return result;
}
export function emailInput(raw: unknown): string {
  return normalizedEmail(objectInput(raw, ['newEmail']).newEmail);
}
export function challengeInput(
  raw: unknown,
  resend = false,
): { challengeId: string; code?: string } | { token: string } {
  const input = objectInput(
    raw,
    resend ? ['challengeId'] : ['challengeId', 'code', 'token'],
  );
  if (
    !resend &&
    Object.keys(input).length === 1 &&
    typeof input.token === 'string' &&
    input.token.length <= 200 &&
    parseToken('email_change', input.token)
  )
    return { token: input.token };
  if (
    typeof input.challengeId !== 'string' ||
    !isChallengeId(input.challengeId)
  )
    bad();
  if (resend && Object.keys(input).length === 1)
    return { challengeId: input.challengeId };
  if (
    !resend &&
    Object.keys(input).length === 2 &&
    typeof input.code === 'string' &&
    input.code.length === 6 &&
    !/[^0-9]/.test(input.code)
  )
    return { challengeId: input.challengeId, code: input.code };
  return bad();
}
