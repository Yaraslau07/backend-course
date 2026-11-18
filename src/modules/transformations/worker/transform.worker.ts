// Runs inside a piscina worker thread: relative imports only (no `@/` alias, no Nest).
import type { ConversionErrorCode } from '../transformation.types';

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

export default function transform(
  task: TransformTask,
): Promise<TransformResult> {
  void task;
  throw new Error('not implemented');
}
