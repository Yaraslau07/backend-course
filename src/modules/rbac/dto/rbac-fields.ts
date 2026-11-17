import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { RBAC_NAME_PATTERN } from '../rbac.types';

const NAME = new RegExp(RBAC_NAME_PATTERN);
export const DESCRIPTION_MAX_LENGTH = 500;
export const ACTIONS_MAX = 64;

/** Trim and lowercase a string; anything else is left for validation to report. */
export const normalizeName = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const normalizeNames = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(normalizeName) : value;

/** A role, permission or action name (spec 1.1 §1.3.2): trimmed, lowercased, then the pattern. */
export function RbacName(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example: 'support', pattern: RBAC_NAME_PATTERN }),
    Transform(({ value }) => normalizeName(value)),
    IsString(),
    Matches(NAME),
  );
}

/** Trimmed; at most 500 characters; an empty string (or nothing) is stored as null. */
export function RbacDescription(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ maxLength: DESCRIPTION_MAX_LENGTH, nullable: true }),
    Transform(({ value }: { value: unknown }) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
    IsOptional(),
    IsString(),
    MaxLength(DESCRIPTION_MAX_LENGTH),
  );
}

/**
 * A list of action names, each normalized like a name. A repeat after normalization is a 400
 * (spec 1.1 §1.3.3), not silently merged.
 */
export function RbacActions(options: { min: number }): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeNames(value)),
    IsArray(),
    ArrayMinSize(options.min),
    ArrayMaxSize(ACTIONS_MAX),
    ArrayUnique(),
    IsString({ each: true }),
    Matches(NAME, { each: true }),
  );
}
