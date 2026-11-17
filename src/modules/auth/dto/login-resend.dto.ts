import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Spec 1.2 §1.3.2: the attempt keeps its method. */
export class LoginResendDto {
  @ApiProperty({ format: 'uuid', description: 'From the 202 response.' })
  @IsUUID('all')
  attemptId!: string;
}
