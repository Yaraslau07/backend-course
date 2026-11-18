// Loaded inside converter worker threads: relative imports and libraries only (D67).

/** Spec 2.1: the four text formats; `.yml` is an alias of `yaml`. */
export const TEXT_FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/** The converter codes a text conversion can fail with (all 400 to the client, D68). */
export type TextErrorCode =
  | 'invalid_input'
  | 'structure_mismatch'
  | 'unsafe_input';

export class TextConversionError extends Error {
  constructor(readonly code: TextErrorCode) {
    super(code);
  }
}

/** The response type of each target. */
export const TEXT_CONTENT_TYPES: Record<TextFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
};

/** Strict UTF-8 with an optional BOM (spec 2.1 §1.1). */
export function decodeUtf8(bytes: Uint8Array): string {
  void bytes;
  throw new Error('not implemented');
}

/** One of the twelve directions (spec 2.1 §1.3.2), or a `TextConversionError`. */
export function convertText(
  source: TextFormat,
  target: TextFormat,
  text: string,
): string {
  void [source, target, text];
  throw new Error('not implemented');
}
