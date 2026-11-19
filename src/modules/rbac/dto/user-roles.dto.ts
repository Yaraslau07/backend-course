import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** Spec 1.1 §1.3.5: the complete list; empty removes every role. */
export class UserRolesDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  // UUIDs are the same id in any letter case, so a repeat that differs only by case is a repeat.
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((id: unknown) =>
          typeof id === 'string' ? id.toLowerCase() : id,
        )
      : value,
  )
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  roleIds!: string[];
}
