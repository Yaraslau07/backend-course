import { AppException } from '@/core/errors/app.exception';
import { duplicateJsonKey } from '@/core/app/json-keys';

import {
  patchFields,
  normalizePatch,
  emailInput,
  challengeInput,
} from './update-input';

describe('C13 update inputs', () => {
  it('accepts only a nonempty whitelist and rejects null/unknown fields', () => {
    for (const input of [
      null,
      [],
      {},
      { password: 'x' },
      { id: 'x' },
      { photoUrl: null },
      { roles: [] },
    ]) {
      expect(() => patchFields(input)).toThrow(AppException);
    }
    expect(patchFields({ displayName: null })).toEqual({ displayName: null });
  });
  it('normalizes names and emails, retains plus tags, and preserves explicit null', () => {
    expect(
      normalizePatch({
        displayName: '  E\u0301va  ',
        email: ' User+Tag@Example.com ',
        status: 'blocked',
      }),
    ).toEqual({
      displayName: 'Éva',
      email: 'user+tag@example.com',
      status: 'blocked',
    });
    expect(normalizePatch({ displayName: null })).toEqual({
      displayName: null,
    });
    expect(
      normalizePatch({ displayName: '😀'.repeat(80) }).displayName,
    ).toHaveLength(160);
  });
  it.each([
    { displayName: '' },
    { displayName: '  ' },
    { displayName: 1 },
    { displayName: 'a\u0000' },
    { displayName: 'a\u009f' },
    { displayName: 'a'.repeat(81) },
    { email: null },
    { email: 'invalid' },
    { status: null },
    { status: 'deleted' },
    { status: 'pending' },
  ])('rejects invalid values %j', (input) => {
    expect(() => normalizePatch(input)).toThrow(AppException);
  });
  it('requires the exact email request shape', () => {
    expect(emailInput({ newEmail: ' NEW@Example.com ' })).toBe(
      'new@example.com',
    );
    for (const raw of [
      { email: 'x@example.com' },
      { newEmail: 'x@example.com', method: 'otp' },
      { newEmail: null },
    ])
      expect(() => emailInput(raw)).toThrow(AppException);
  });
  it('requires exactly one valid confirmation variant', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(challengeInput({ challengeId: id, code: '123456' })).toEqual({
      challengeId: id,
      code: '123456',
    });
    expect(challengeInput({ challengeId: id }, true)).toEqual({
      challengeId: id,
    });
    for (const raw of [
      {},
      { challengeId: id },
      { challengeId: id, code: '123456\n' },
      { token: 'invalid' },
      { token: 'x', challengeId: id, code: '123456' },
    ])
      expect(() => challengeInput(raw)).toThrow(AppException);
  });
});

describe('duplicate JSON keys', () => {
  it.each([
    '{"displayName":"one","displayName":"two"}',
    '{"email":1,"\\u0065mail":2}',
    '{"nested":{"x":1,"x":2}}',
  ])('rejects a repeated decoded key in %s', (text) => {
    expect(duplicateJsonKey(text)).toBe(true);
  });
  it.each([
    '{"displayName":"text: \\"quoted\\""}',
    '{"one":{"x":1},"two":{"x":2}}',
    '[{"x":1},{"x":2}]',
    '{"x":"a","y":["x",1]}',
  ])('allows independent objects and string contents in %s', (text) => {
    expect(duplicateJsonKey(text)).toBe(false);
  });
});
