// Runs inside a piscina worker thread: relative imports only (no `@/` alias, no Nest).
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Converter, ConverterOutcome } from '../converter';
import {
  type ConversionErrorCode,
  isConversionErrorCode,
} from '../transformation.types';

export interface TransformTask {
  /** A module path from the converter registry. */
  module: string;
  inputPath: string;
  outputPath: string;
  params: Record<string, unknown>;
  outputLimit: number;
}

export type TransformResult =
  | { ok: true; contentType: string; extension: string; size: number }
  | { ok: false; code: ConversionErrorCode };

/** A media type, optionally with a charset; nothing that could break a header. */
const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(; ?charset=[a-z0-9_-]+)?$/i;
const EXTENSION = /^[a-z0-9]{1,8}$/;

/** Counts the result and fails the stream the moment it would pass the direction's limit. */
class ByteLimit extends Transform {
  bytes = 0;
  exceeded = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.exceeded = true;
      done(new Error('result_too_large'));
      return;
    }
    done(null, chunk);
  }
}

const converters = new Map<string, Converter>();

function load(module: string): Converter {
  let converter = converters.get(module);
  if (!converter) {
    // CommonJS `require`, so the ts-node hook also loads TypeScript converters in tests (D67).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(module) as { converter?: Converter };
    if (typeof loaded.converter?.convert !== 'function')
      throw new Error('not a converter module');
    converter = loaded.converter;
    converters.set(module, converter);
  }
  return converter;
}

const failure = (code: ConversionErrorCode): TransformResult => ({
  ok: false,
  code,
});

/**
 * One conversion: input file → converter → size limit → output file (spec 2.0 §1.3.1). The output
 * is created exclusively (`wx`, 0600), so an existing path is never overwritten. On any failure
 * the partial output is removed; library messages never leave this function.
 */
export default async function transform(
  task: TransformTask,
): Promise<TransformResult> {
  let converter: Converter;
  try {
    converter = load(task.module);
  } catch {
    return failure('converter_failed');
  }

  const input = createReadStream(task.inputPath);
  const limiter = new ByteLimit(task.outputLimit);
  const sink = createWriteStream(task.outputPath, { flags: 'wx', mode: 0o600 });
  let created = false;
  sink.once('open', () => {
    created = true;
  });
  const written = pipeline(limiter, sink).then(
    () => true,
    () => false,
  );

  const fail = async (code: ConversionErrorCode): Promise<TransformResult> => {
    input.destroy();
    limiter.destroy();
    await written;
    if (created) await rm(task.outputPath, { force: true });
    return failure(code);
  };

  let outcome: ConverterOutcome;
  try {
    outcome = await converter.convert(input, task.params, limiter);
  } catch {
    return fail(limiter.exceeded ? 'result_too_large' : 'converter_failed');
  }
  if (limiter.exceeded) return fail('result_too_large');
  if (!outcome.ok)
    return fail(
      isConversionErrorCode(outcome.code) ? outcome.code : 'converter_failed',
    );
  if (
    !CONTENT_TYPE.test(outcome.contentType) ||
    !EXTENSION.test(outcome.extension)
  )
    return fail('converter_failed');

  if (!limiter.writableEnded) limiter.end();
  if (!(await written))
    return fail(limiter.exceeded ? 'result_too_large' : 'converter_failed');
  input.destroy();
  return {
    ok: true,
    contentType: outcome.contentType,
    extension: outcome.extension,
    size: limiter.bytes,
  };
}
