import { Injectable } from '@nestjs/common';

import type { TransformationType } from './transformation.types';

/** Per-direction limits (specs 2.1 and 2.2 set them; configuration may lower or raise them). */
export interface ConversionLimits {
  inputBytes: number;
  outputBytes: number;
  timeoutMs: number;
}

/** One registered direction (spec 2.0 §1.1: exactly one converter per direction). */
export interface ConverterDefinition {
  type: TransformationType;
  source: string;
  target: string;
  /** Absolute path of the worker-side module that exports `converter`. */
  module: string;
  limits: ConversionLimits;
}

@Injectable()
export class ConverterRegistry {
  register(definition: ConverterDefinition): void {
    void definition;
    throw new Error('not implemented');
  }

  find(
    type: TransformationType,
    source: string,
    target: string,
  ): ConverterDefinition | undefined {
    void [type, source, target];
    throw new Error('not implemented');
  }

  /** The formats endpoints' answer: each source with its targets, in registration order. */
  directions(type: TransformationType): { source: string; target: string[] }[] {
    void type;
    throw new Error('not implemented');
  }
}
