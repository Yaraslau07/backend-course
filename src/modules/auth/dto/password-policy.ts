import { registerDecorator, type ValidationOptions } from 'class-validator';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-hasher';

/** Characters as people count them (code points), so an emoji is one, not two. */
const length = (value: string) => [...value].length;

function rule(
  name: string,
  test: (value: string) => boolean,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && test(value),
        defaultMessage: () => `${String(propertyName)} fails ${name}`,
      },
    });
}

/**
 * Spec 1.0: at least 8 characters, at least one letter of any alphabet and one digit. An over-long
 * password is rejected, never cut (D40). The value is checked as sent: never trimmed or normalized.
 */
export function PasswordPolicy(): PropertyDecorator {
  const decorators = [
    rule(
      'passwordLength',
      (v) =>
        length(v) >= PASSWORD_MIN_LENGTH && length(v) <= PASSWORD_MAX_LENGTH,
    ),
    rule('passwordHasLetter', (v) => /\p{L}/u.test(v)),
    rule('passwordHasDigit', (v) => /\p{Nd}/u.test(v)),
  ];
  return (target, propertyName) =>
    decorators.forEach((decorate) => decorate(target, propertyName));
}
