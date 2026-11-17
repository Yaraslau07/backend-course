import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Spec 1.2 §1.3.2. Exactly one variant: `attemptId` + `code` (OTP), or `token` (magic link,
 * `attemptId.secret`).
 */
export class LoginConfirmDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'OTP: from the 202 response.',
  })
  @IsOptional()
  @IsUUID('all')
  attemptId?: string;

  @ApiPropertyOptional({
    example: '048213',
    description: 'OTP: the six digits from the email.',
  })
  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @ApiPropertyOptional({
    description: 'Magic link: the `token` from the link fragment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  token?: string;
}
