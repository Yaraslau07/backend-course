import { join } from 'node:path';

import {
  type ConverterDefinition,
  ConverterRegistry,
} from './converter-registry';

const MODULE = join(__dirname, '../../../test/utils/probe-converter.ts');
const def = (
  fields: Partial<ConverterDefinition> = {},
): ConverterDefinition => ({
  type: 'file',
  source: 'csv',
  target: 'json',
  module: MODULE,
  limits: { inputBytes: 10, outputBytes: 20, timeoutMs: 100 },
  ...fields,
});

describe('ConverterRegistry (spec 2.0 §1.1, §1.3.1)', () => {
  it('finds a registered direction and lists directions per source, in order', () => {
    const registry = new ConverterRegistry();
    registry.register(def());
    registry.register(def({ target: 'yaml' }));
    registry.register(def({ source: 'json', target: 'csv' }));
    registry.register(def({ type: 'image', source: 'png', target: 'jpeg' }));
    expect(registry.find('file', 'csv', 'yaml')?.target).toBe('yaml');
    expect(registry.find('file', 'csv', 'xml')).toBeUndefined();
    expect(registry.find('image', 'csv', 'json')).toBeUndefined();
    expect(registry.directions('file')).toEqual([
      { source: 'csv', target: ['json', 'yaml'] },
      { source: 'json', target: ['csv'] },
    ]);
    expect(registry.directions('image')).toEqual([
      { source: 'png', target: ['jpeg'] },
    ]);
  });

  it('refuses a second converter for a direction', () => {
    const registry = new ConverterRegistry();
    registry.register(def());
    expect(() => registry.register(def())).toThrow(/already registered/);
  });

  it.each([
    ['a format outside the pattern', def({ source: 'CSV' })],
    ['a direction to itself', def({ target: 'csv' })],
    ['a relative module path', def({ module: 'probe-converter.ts' })],
    [
      'a module that does not exist',
      def({ module: join(__dirname, 'missing.ts') }),
    ],
    [
      'a non-positive limit',
      def({ limits: { inputBytes: 0, outputBytes: 1, timeoutMs: 1 } }),
    ],
  ])('refuses %s', (_name, definition) => {
    expect(() => new ConverterRegistry().register(definition)).toThrow();
  });
});
