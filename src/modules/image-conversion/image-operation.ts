import type { AppConfig } from '@/core/config/config.types';
import { AppException } from '@/core/errors/app.exception';
import type { ConversionOperation } from '@/modules/transformations/transformation.service';

import {
  IMAGE_TARGETS,
  type ImageOptions,
  type ImageSource,
  MAX_SIDE,
} from './image-formats';

export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageSource>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  svg: 'svg',
};
/** Each format's own types, plus `application/octet-stream` as "unspecified" (D70, D73). */
const MIME_TYPES: Readonly<Record<ImageSource, readonly string[]>> = {
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  svg: ['image/svg+xml'],
};
const UNSPECIFIED = ['application/octet-stream'];
/** A result is never larger than this; the real bound is the pixel limit (spec 2.2 §1.1). */
export const IMAGE_OUTPUT_BYTES = 100 * 1024 * 1024;

export type ImageLimits = Record<ImageSource, number>;
type Get = <K extends keyof AppConfig>(key: K) => AppConfig[K];

export function imageLimits(get: Get): ImageLimits {
  return {
    png: get('IMAGE_PNG_MAX_BYTES'),
    jpeg: get('IMAGE_JPEG_MAX_BYTES'),
    svg: get('IMAGE_SVG_MAX_BYTES'),
  };
}

const bad = (): never => {
  throw new AppException('bad_request');
};
const integer = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : bad();

/**
 * Spec 2.2 §1.3.2: `options` is a JSON object; `quality` and `background` apply only to a JPEG
 * result, `width` and `height` only to an SVG source. Unknown or inapplicable fields are 400.
 */
export function parseImageOptions(
  raw: string | undefined,
  source: ImageSource,
  target: string,
): ImageOptions {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return bad();
  const options: ImageOptions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'quality' && target === 'jpeg')
      options.quality = integer(value, 1, 100);
    else if (key === 'background' && target === 'jpeg') {
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) bad();
      options.background = (value as string).toLowerCase();
    } else if ((key === 'width' || key === 'height') && source === 'svg')
      options[key] = integer(value, 1, MAX_SIDE);
    else bad();
  }
  return options;
}

function formatOf(extension: string, mime: string): ImageSource | null {
  const format = IMAGE_EXTENSIONS[extension];
  if (!format) return null;
  const type = mime.split(';')[0].trim().toLowerCase();
  return MIME_TYPES[format].includes(type) || UNSPECIFIED.includes(type)
    ? format
    : null;
}

/**
 * `POST /api/images/convert` (spec 2.2 §1.3.1): one PNG, JPEG or SVG, `targetFormat` `png` or
 * `jpeg`, optional `options` (JSON) and `save` (`true`/`false`, spec 2.4). A direction outside the
 * four (to SVG, to itself, to anything else) is 415.
 */
export function imageOperation(
  limits: ImageLimits,
  timeoutMs: number,
): ConversionOperation {
  return {
    type: 'image',
    fields: ['targetFormat', 'options', 'save'],
    maxFileBytes: Math.max(...Object.values(limits)),
    limitFor: (extension, mime) => {
      const format = formatOf(extension, mime);
      return format ? limits[format] : null;
    },
    resolve: ({ file, fields }) => {
      const source = IMAGE_EXTENSIONS[file.extension];
      const target = fields.targetFormat;
      if (target === undefined) bad();
      if (
        !(IMAGE_TARGETS as readonly string[]).includes(target) ||
        target === source
      )
        throw new AppException('unsupported_media_type');
      if (
        fields.save !== undefined &&
        fields.save !== 'true' &&
        fields.save !== 'false'
      )
        bad();
      const options = parseImageOptions(fields.options, source, target);
      return {
        source,
        target,
        // The library's own timeout fires a little before the pool's, so it stops cleanly.
        params: {
          source,
          target,
          options,
          timeoutSeconds: Math.max(1, Math.floor(timeoutMs / 1000) - 1),
        },
      };
    },
  };
}
