import { ApiProperty } from '@nestjs/swagger';

import {
  ACTIONS_MAX,
  RbacActions,
  RbacDescription,
  RbacName,
} from './rbac-fields';

/** Spec 1.1 §1.3.3: 1 to 64 unique actions; the whole set is replaced on PUT. */
export class PermissionDto {
  @RbacName()
  name!: string;

  @RbacDescription()
  description!: string | null;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: ACTIONS_MAX,
    example: ['read', 'update'],
  })
  @RbacActions({ min: 1 })
  actions!: string[];
}
