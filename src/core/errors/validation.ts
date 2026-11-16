import type { ValidationError } from 'class-validator';

import { AppException } from './app.exception';

/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
export function validationExceptionFactory(
  _errors: ValidationError[],
): AppException {
  throw new Error('not implemented');
}
