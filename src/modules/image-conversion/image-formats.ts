// Loaded inside converter worker threads: relative imports and libraries only (D67).

export const IMAGE_SOURCES = ['png', 'jpeg', 'svg'] as const;
export const IMAGE_TARGETS = ['png', 'jpeg'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export type ImageTarget = (typeof IMAGE_TARGETS)[number];

/** Spec 2.2 §1.1: the result's largest side and pixel count. */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 16_777_216;
export const DEFAULT_QUALITY = 85;
export const DEFAULT_BACKGROUND = '#ffffff';
/** Spec 2.2 §1.3.2: an SVG with no intrinsic size renders at 1024×1024. */
export const DEFAULT_SVG_SIDE = 1024;

/** Verified options (spec 2.2 §1.3.2); the endpoint only passes the ones that apply. */
export interface ImageOptions {
  quality?: number;
  width?: number;
  height?: number;
  background?: string;
}

export type ImageErrorCode =
  | 'invalid_input'
  | 'unsafe_input'
  | 'content_mismatch'
  | 'result_too_large';

export class ImageConversionError extends Error {
  constructor(readonly code: ImageErrorCode) {
    super(code);
  }
}

export interface ConvertedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

/** One of the four directions, or an `ImageConversionError`. */
export function convertImage(
  source: ImageSource,
  target: ImageTarget,
  bytes: Buffer,
  options: ImageOptions,
): Promise<ConvertedImage> {
  void [source, target, bytes, options];
  throw new Error('not implemented');
}
