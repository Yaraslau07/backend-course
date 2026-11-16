import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

import { EMAIL_MAX_LENGTH, normalizeEmail } from '@/modules/users/normalize';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-hasher';
import { PasswordPolicy } from './password-policy';

export class RegisterDto {
  @ApiProperty({
    example: 'user@example.com',
    maxLength: EMAIL_MAX_LENGTH,
    description:
      'Trimmed and lowercased before use; `user+tag@…` is a separate address.',
  })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({
    example: 'correct horse 1',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description:
      'At least one letter (any alphabet) and one digit. Spaces count; nothing is trimmed.',
  })
  @IsString()
  @PasswordPolicy()
  password!: string;
}
