/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import { Injectable } from '@nestjs/common';

export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordHasher {
  hash(_password: string): Promise<string> {
    throw new Error('not implemented');
  }

  verify(_hash: string, _password: string): Promise<boolean> {
    throw new Error('not implemented');
  }
}
