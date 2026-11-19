/**
 * What a stored result is served as (spec 2.4 §1.3.2): the content type of its target format, and
 * `converted.<format>` as its name. Derived from the history row, so nothing else is stored. The text
 * types match the converters' own (`text-formats.ts`).
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** A format no converter knows is served as opaque bytes, never guessed. */
export function contentTypeOf(format: string): string {
  return Object.hasOwn(CONTENT_TYPES, format)
    ? CONTENT_TYPES[format]
    : 'application/octet-stream';
}

/** The target format is already a lowercase `[a-z0-9]{1,16}` (`ck_transformations_formats`). */
export function fileNameOf(format: string): string {
  return `converted.${format}`;
}
