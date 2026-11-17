import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

import { ACTIONS_MAX, RbacActions } from './rbac-fields';

/**
 * Spec 1.1 §1.3.4. No `actions`, or an empty list, means every current and future action of the
 * permission; otherwise exactly these.
 */
export class GrantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  roleId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  permissionId!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: ACTIONS_MAX,
    description: 'Omitted or empty: all actions, including ones added later.',
  })
  @IsOptional()
  @RbacActions({ min: 0 })
  actions?: string[];
}
