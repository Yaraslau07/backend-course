import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { EMAIL_MAX_LENGTH, normalizeEmail } from '@/modules/users/normalize';

import { PASSWORD_MAX_LENGTH } from '../password-hasher';

/**
 * Spec 1.2 §1.3.1. The password policy is not re-checked here: only its bounds, so an over-long
 * value is a format error (400) and never reaches argon2. Nothing is trimmed.
 */
export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    maxLength: EMAIL_MAX_LENGTH,
    description: 'Trimmed and lowercased before use.',
  })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({
    example: 'correct horse 1',
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'Exactly as registered: spaces count, nothing is trimmed.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
