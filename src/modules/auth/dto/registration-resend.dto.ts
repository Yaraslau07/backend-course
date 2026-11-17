import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import { EMAIL_MAX_LENGTH, normalizeEmail } from '@/modules/users/normalize';

export class RegistrationResendDto {
  @ApiProperty({ example: 'user@example.com' })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}
