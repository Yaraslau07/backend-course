/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { TokenService, type TokenPair } from './tokens/token.service';

/** Spec 1.2 §1.3.4: a new pair from a valid refresh token, for a user who is still `active`. */
@Injectable()
export class SessionService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tokens: TokenService,
  ) {}

  refresh(_refreshToken: string | undefined): Promise<TokenPair> {
    throw new Error('not implemented');
  }
}
