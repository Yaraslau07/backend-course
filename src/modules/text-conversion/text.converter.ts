// The worker-side converter for all twelve text directions (D67: relative imports only).
import type { Writable } from 'node:stream';

import type { Converter } from '../transformations/converter';
import {
  convertText,
  decodeUtf8,
  isTextFormat,
  TEXT_CONTENT_TYPES,
  TextConversionError,
} from './text-formats';

function end(output: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.once('error', reject);
    output.end(data, () => resolve());
  });
}

/**
 * Reads the whole input (already limited by the intake), converts it with the libraries in
 * `text-formats.ts` and writes the whole result. Format problems come back as safe codes; the
 * output limit is enforced by the worker's stream (`result_too_large`).
 */
export const converter: Converter = {
  async convert(input, params, output) {
    const { source, target } = params;
    if (!isTextFormat(source) || !isTextFormat(target))
      throw new Error('unsupported direction');
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    let result: string;
    try {
      result = convertText(source, target, decodeUtf8(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof TextConversionError)
        return { ok: false, code: error.code };
      throw error;
    }
    await end(output, result);
    return {
      ok: true,
      contentType: TEXT_CONTENT_TYPES[target],
      extension: target,
    };
  },
};
