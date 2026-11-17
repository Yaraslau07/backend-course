/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { RateLimiter } from '@/core/rate-limit/rate-limiter.service';
import { ChallengeEngine } from '@/modules/challenges/challenge-engine.service';

import type { LoginDto } from './dto/login.dto';
import type { LoginConfirmDto } from './dto/login-confirm.dto';
import type { LoginResendDto } from './dto/login-resend.dto';
import { PasswordHasher } from './password-hasher';
import { TokenService, type TokenPair } from './tokens/token.service';

export type LoginResult =
  | { kind: 'session'; pair: TokenPair }
  | { kind: 'challenge'; body: Record<string, unknown> };

/** Spec 1.2 §1.3.1–1.3.2: login by email and password, with the optional email step. */
@Injectable()
export class LoginService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly challenges: ChallengeEngine,
    private readonly limiter: RateLimiter,
  ) {}

  async onModuleInit(): Promise<void> {}

  login(_dto: LoginDto, _ip: string): Promise<LoginResult> {
    throw new Error('not implemented');
  }

  confirm(_dto: LoginConfirmDto): Promise<TokenPair> {
    throw new Error('not implemented');
  }

  resend(_dto: LoginResendDto): Promise<Record<string, unknown>> {
    throw new Error('not implemented');
  }
}
