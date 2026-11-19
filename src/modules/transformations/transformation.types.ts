import type { ErrorCode } from '../../core/errors/error-catalogue';

/** Spec 2.3 §1.3.1: `file` (text formats, 2.1) or `image` (2.2). */
export const TRANSFORMATION_TYPES = ['file', 'image'] as const;
export type TransformationType = (typeof TRANSFORMATION_TYPES)[number];

export const TRANSFORMATION_STATUSES = ['success', 'error'] as const;
export type TransformationStatus = (typeof TRANSFORMATION_STATUSES)[number];

/** Spec 2.4 §1.3.4: what became of `save`. A queue of `pending` rows is the worker's task list. */
export const TRANSFORMATION_STORAGE_STATUSES = [
  'not_requested',
  'pending',
  'available',
  'error',
] as const;
export type TransformationStorageStatus =
  (typeof TRANSFORMATION_STORAGE_STATUSES)[number];

/** Writes to object storage before a `pending` save becomes `error` (spec 2.4 §1.3.1, D79). */
export const STORAGE_MAX_ATTEMPTS = 5;

/**
 * The safe codes a conversion can end with (spec 2.0 §1.3.1, §1.4). They are stored in
 * `transformations.error_code` and logged; the client sees only the HTTP code mapped below.
 */
export const CONVERSION_ERRORS = {
  /** The library could not read the input: damaged file, bad syntax or encoding. */
  invalid_input: 'invalid_file',
  /** The input parsed, but its structure can't be expressed in the target format. */
  structure_mismatch: 'invalid_file',
  /** The input is unsafe to process (for example an SVG with scripts or external resources). */
  unsafe_input: 'invalid_file',
  /** The content doesn't match its declared format. */
  content_mismatch: 'unsupported_media_type',
  /** The result would exceed the direction's output limit. */
  result_too_large: 'payload_too_large',
  /** The converter didn't finish within the direction's timeout. */
  timeout: 'gateway_timeout',
  /** The converter or its worker failed unexpectedly, or a dependency is unavailable. */
  converter_failed: 'service_unavailable',
} as const satisfies Record<string, ErrorCode>;
export type ConversionErrorCode = keyof typeof CONVERSION_ERRORS;

export function isConversionErrorCode(
  value: unknown,
): value is ConversionErrorCode {
  return typeof value === 'string' && Object.hasOwn(CONVERSION_ERRORS, value);
}
