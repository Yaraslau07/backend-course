// The worker-side converter for the four image directions (D67: relative imports only).
import type { Writable } from 'node:stream';

import type { Converter } from '../transformations/converter';
import {
  convertImage,
  ImageConversionError,
  type ImageOptions,
  type ImageSource,
  type ImageTarget,
  isDirection,
} from './image-formats';

function end(output: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.once('error', reject);
    output.end(data, () => resolve());
  });
}

/**
 * Reads the whole input (already limited by the intake), converts it with sharp and resvg, and
 * writes the whole result. Problems come back as safe codes; the byte limit is the worker's.
 */
export const converter: Converter = {
  async convert(input, params, output) {
    const { source, target, options, timeoutSeconds } = params;
    if (!isDirection(source, target)) throw new Error('unsupported direction');
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    let bytes: Buffer;
    try {
      ({ bytes } = await convertImage(
        source as ImageSource,
        target as ImageTarget,
        Buffer.concat(chunks),
        (options ?? {}) as ImageOptions,
        typeof timeoutSeconds === 'number' ? timeoutSeconds : 25,
      ));
    } catch (error) {
      if (error instanceof ImageConversionError)
        return { ok: false, code: error.code };
      throw error;
    }
    await end(output, bytes);
    return {
      ok: true,
      contentType: target === 'png' ? 'image/png' : 'image/jpeg',
      extension: target as string,
    };
  },
};
