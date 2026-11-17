import { ApiProperty } from '@nestjs/swagger';

import { USER_STATUSES, type UserStatus } from '../users.types';

/** Documentation of the fixed projection; no entity is ever serialized as an HTTP response. */
export class SafeProfileDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Full normalized email' })
  email: string;

  @ApiProperty({ type: String, nullable: true })
  displayName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Protected API URL; never a storage URL',
  })
  photoUrl: string | null;

  @ApiProperty({ enum: USER_STATUSES })
  status: UserStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class UserListPageDto {
  @ApiProperty({ type: [SafeProfileDto] })
  items: SafeProfileDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Signed cursor; repeat the normalized query unchanged, expires after 15 minutes',
  })
  nextCursor: string | null;
}
