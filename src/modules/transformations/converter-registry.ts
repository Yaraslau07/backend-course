import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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

/** The same pattern `ck_transformations_formats` enforces. */
const FORMAT = /^[a-z0-9]{1,16}$/;

/**
 * Every supported direction. Modules register theirs in `onModuleInit`; a new pair never changes an
 * existing one (spec 2.0 user story 3). A bad definition is a programming error and fails startup.
 */
@Injectable()
export class ConverterRegistry {
  private readonly definitions = new Map<string, ConverterDefinition>();

  register(definition: ConverterDefinition): void {
    const { type, source, target, module, limits } = definition;
    if (!FORMAT.test(source) || !FORMAT.test(target) || source === target)
      throw new Error(`Invalid direction ${source} → ${target}`);
    if (!isAbsolute(module) || !existsSync(module))
      throw new Error(`Converter module for ${source} → ${target} not found`);
    if (
      ![limits.inputBytes, limits.outputBytes, limits.timeoutMs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new Error(`Invalid limits for ${source} → ${target}`);
    const key = this.key(type, source, target);
    if (this.definitions.has(key))
      throw new Error(
        `A converter for ${type} ${source} → ${target} is already registered`,
      );
    this.definitions.set(key, { ...definition, limits: { ...limits } });
  }

  find(
    type: TransformationType,
    source: string,
    target: string,
  ): ConverterDefinition | undefined {
    return this.definitions.get(this.key(type, source, target));
  }

  /** The formats endpoints' answer: each source with its targets, in registration order. */
  directions(type: TransformationType): { source: string; target: string[] }[] {
    const bySource = new Map<string, string[]>();
    for (const definition of this.definitions.values()) {
      if (definition.type !== type) continue;
      const targets = bySource.get(definition.source) ?? [];
      targets.push(definition.target);
      bySource.set(definition.source, targets);
    }
    return [...bySource].map(([source, target]) => ({ source, target }));
  }

  private key(type: string, source: string, target: string): string {
    return `${type}:${source}:${target}`;
  }
}
