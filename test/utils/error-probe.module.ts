import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Module,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';

export const PROBE_SECRET = 'probe-secret-value-7f3a';

class Address {
  @IsString()
  city!: string;
}

class ProbeBody {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsInt()
  @Min(1)
  count!: number;

  @ValidateNested()
  @Type(() => Address)
  address!: Address;
}

/** Test-only routes that fail in every way the error filter must handle. */
@Controller('__probe')
class ErrorProbeController {
  constructor(private readonly dataSource: DataSource) {}

  @Post('validate')
  @HttpCode(200)
  validate(@Body() body: ProbeBody): { ok: true; count: number } {
    return { ok: true, count: body.count };
  }

  @Get('app-exception')
  appException(): never {
    throw new AppException('too_many_requests', {
      retryAfterSeconds: 17,
      attemptId: 'attempt-1',
    });
  }

  @Get('nest-exception')
  nestException(): never {
    throw new ForbiddenException(`details with ${PROBE_SECRET}`);
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error(`unexpected failure with ${PROBE_SECRET}`);
  }

  @Get('unique-violation')
  async uniqueViolation(): Promise<never> {
    await this.dataSource.query(
      `DO $$ BEGIN RAISE EXCEPTION 'duplicate' USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_probe'; END $$`,
    );
    throw new Error('unreachable');
  }

  @Get('statement-timeout')
  async statementTimeout(): Promise<never> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL statement_timeout = 50`);
      await manager.query(`SELECT pg_sleep(1)`);
    });
    throw new Error('unreachable');
  }

  /** Postgres puts the offending value in the message: `invalid input value for enum …: "…"`. */
  @Get('db-error-with-value')
  async dbErrorWithValue(): Promise<never> {
    await this.dataSource.query(`SELECT $1::user_status`, [PROBE_SECRET]);
    throw new Error('unreachable');
  }
}

@Module({ controllers: [ErrorProbeController] })
export class ErrorProbeModule {}
