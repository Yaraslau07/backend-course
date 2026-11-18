import { AppException } from '@/core/errors/app.exception';
import type { AppConfig } from '@/core/config/config.types';
import type { ConversionOperation } from '@/modules/transformations/transformation.service';

import { TEXT_FORMATS, type TextFormat } from './text-formats';

/** Spec 2.1 §1.1: the result limit and the timeout of every text direction. */
export const TEXT_OUTPUT_BYTES = 50 * 1024 * 1024;

export const TEXT_EXTENSIONS: Readonly<Record<string, TextFormat>> = {
  csv: 'csv',
  json: 'json',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * The MIME types each format accepts. `application/octet-stream` and `text/plain` mean "unspecified"
 * (many clients send them for any file, D70); a clearly different type is 415.
 */
const MIME_TYPES: Readonly<Record<TextFormat, readonly string[]>> = {
  csv: ['text/csv', 'application/csv', 'text/comma-separated-values'],
  json: ['application/json', 'text/json'],
  xml: ['application/xml', 'text/xml'],
  yaml: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'],
};
const UNSPECIFIED = ['application/octet-stream', 'text/plain'];

export type TextLimits = Record<TextFormat, number>;

export function textLimits(
  get: <K extends keyof AppConfig>(key: K) => AppConfig[K],
): TextLimits {
  return {
    csv: get('TEXT_CSV_MAX_BYTES'),
    json: get('TEXT_JSON_MAX_BYTES'),
    xml: get('TEXT_XML_MAX_BYTES'),
    yaml: get('TEXT_YAML_MAX_BYTES'),
  };
}

function formatOf(extension: string, mime: string): TextFormat | null {
  const format = TEXT_EXTENSIONS[extension];
  if (!format) return null;
  const type = mime.split(';')[0].trim().toLowerCase();
  return MIME_TYPES[format].includes(type) || UNSPECIFIED.includes(type)
    ? format
    : null;
}

/**
 * `POST /api/convert` (spec 2.1 §1.3.1): one `.csv/.json/.xml/.yaml/.yml` file, `targetFormat` (one
 * of the four, not the source), optional `save` (`true`/`false`, used by spec 2.4), nothing else.
 */
export function textOperation(limits: TextLimits): ConversionOperation {
  return {
    type: 'file',
    fields: ['targetFormat', 'save'],
    maxFileBytes: Math.max(...Object.values(limits)),
    limitFor: (extension, mime) => {
      const format = formatOf(extension, mime);
      return format ? limits[format] : null;
    },
    resolve: ({ file, fields }) => {
      const source = TEXT_EXTENSIONS[file.extension];
      const target = fields.targetFormat as TextFormat | undefined;
      if (
        target === undefined ||
        !(TEXT_FORMATS as readonly string[]).includes(target) ||
        target === source
      )
        throw new AppException('bad_request');
      if (
        fields.save !== undefined &&
        fields.save !== 'true' &&
        fields.save !== 'false'
      )
        throw new AppException('bad_request');
      return { source, target, params: { source, target } };
    },
  };
}
