import type { Readable, Writable } from 'node:stream';

import type { ConversionErrorCode } from './transformation.types';

/**
 * The converter contract (spec 2.0 §1.3.1). A converter runs inside a worker thread, gets the input
 * stream, the parameters its endpoint already verified, and the output stream. It calls a library
 * (never a parser or codec of its own), writes the whole result, ends the output, and reports what
 * it produced, or a safe error code. It never sees a JWT, an HTTP request or the history.
 *
 * A converter module exports `converter`. It may import only relative paths and libraries: worker
 * threads don't resolve the `@/` alias.
 */
export interface Converter {
  convert(
    input: Readable,
    params: Readonly<Record<string, unknown>>,
    output: Writable,
  ): Promise<ConverterOutcome>;
}

export type ConverterOutcome =
  | { ok: true; contentType: string; extension: string }
  | { ok: false; code: ConversionErrorCode };
