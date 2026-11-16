import type { ValidationError } from 'class-validator';

import { AppException, type FieldError } from './app.exception';

const MAX_ERRORS = 50;
/** Unknown property names come from the client; keep them short. */
const MAX_FIELD_LENGTH = 100;

function collect(
  errors: ValidationError[],
  prefix: string,
  out: FieldError[],
): void {
  for (const error of errors) {
    if (out.length >= MAX_ERRORS) return;
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      out.push({
        field: field.slice(0, MAX_FIELD_LENGTH),
        rules: Object.keys(error.constraints),
      });
    }
    if (error.children?.length) collect(error.children, field, out);
  }
}

/**
 * For the global ValidationPipe: reports which fields failed which rules. class-validator's own
 * messages are dropped because some of them repeat the submitted value.
 */
export function validationExceptionFactory(
  errors: ValidationError[],
): AppException {
  const fields: FieldError[] = [];
  collect(errors, '', fields);
  return new AppException('validation_failed', { errors: fields });
}
