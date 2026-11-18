// A test-only converter, loaded by the real worker pool. Relative type imports only (D67).
import type { Readable, Writable } from 'node:stream';

import type {
  Converter,
  ConverterOutcome,
} from '../../src/modules/transformations/converter';

async function text(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function write(output: Writable, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.once('error', reject);
    output.end(data, () => resolve());
  });
}

/**
 * `params.mode` picks the behaviour: `upper` (the happy path), `fail` (a library refusal), `throw`,
 * `hang` (a CPU-bound loop the pool must terminate), `big` (more output than allowed), `bad_code`
 * (an unknown error code) and `no_end` (forgets to end the output).
 */
export const converter: Converter = {
  async convert(input, params, output): Promise<ConverterOutcome> {
    const body = await text(input);
    switch (params.mode) {
      case 'fail':
        return { ok: false, code: 'invalid_input' };
      case 'throw':
        throw new Error(`library detail: ${body}`);
      case 'hang':
        for (;;) {
          // Busy, like a stuck codec: only terminating the thread stops it.
        }
      case 'big':
        await write(output, Buffer.alloc(Number(params.size ?? 4096), 120));
        return { ok: true, contentType: 'text/plain', extension: 'upper' };
      case 'bad_code':
        return { ok: false, code: 'nope' as never };
      case 'no_end':
        output.write(body.toUpperCase());
        return { ok: true, contentType: 'text/plain', extension: 'upper' };
      default:
        await write(output, body.toUpperCase());
        return {
          ok: true,
          contentType: 'text/plain; charset=utf-8',
          extension: 'upper',
        };
    }
  },
};
