import { Injectable } from '@nestjs/common';

import type { SafeProfile } from './safe-profile';
import type { PhotoInput } from './photo-normalizer';

@Injectable()
export class UsersUpdateService {
  patch(actor: string, target: string, raw: unknown): Promise<SafeProfile> {
    void actor;
    void target;
    void raw;
    throw new Error('not implemented');
  }
  startEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    void actor;
    void target;
    void raw;
    throw new Error('not implemented');
  }
  resendEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    void actor;
    void target;
    void raw;
    throw new Error('not implemented');
  }
  confirmEmail(
    actor: string,
    target: string,
    raw: unknown,
  ): Promise<SafeProfile> {
    void actor;
    void target;
    void raw;
    throw new Error('not implemented');
  }
  upload(
    actor: string,
    target: string,
    load: () => Promise<PhotoInput>,
  ): Promise<SafeProfile> {
    void actor;
    void target;
    void load;
    throw new Error('not implemented');
  }
  clearPhoto(actor: string, target: string): Promise<void> {
    void actor;
    void target;
    throw new Error('not implemented');
  }
}
