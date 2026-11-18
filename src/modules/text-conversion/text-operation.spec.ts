import { AppException } from '@/core/errors/app.exception';

import { textOperation } from './text-operation';

const limits = { csv: 10, json: 20, xml: 30, yaml: 40 };
const op = textOperation(limits);
const upload = (extension: string, fields: Record<string, string>) => ({
  file: { path: '/x', size: 1, extension, mime: 'text/plain' },
  fields,
});
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};

describe('textOperation() (spec 2.1 §1.3.1)', () => {
  it('accepts exactly targetFormat and save, with the largest limit as the parser cap', () => {
    expect(op.fields).toEqual(['targetFormat', 'save']);
    expect(op.maxFileBytes).toBe(40);
    expect(op.type).toBe('file');
  });

  it.each([
    ['csv', 'text/csv', 10],
    ['csv', 'application/vnd.ms-excel', null],
    ['json', 'application/json; charset=utf-8', 20],
    ['json', 'APPLICATION/JSON', 20],
    ['xml', 'text/xml', 30],
    ['xml', 'application/json', null],
    ['yaml', 'application/x-yaml', 40],
    ['yml', 'text/yaml', 40],
    ['json', 'application/octet-stream', 20],
    ['yml', 'text/plain', 40],
    ['json', 'image/png', null],
    ['txt', 'text/plain', null],
    ['', 'application/json', null],
  ])('%s as %s → %p', (extension, mime, limit) => {
    expect(op.limitFor(extension, mime)).toBe(limit);
  });

  it('resolves the source from the extension and passes source/target to the converter', () => {
    expect(
      op.resolve(upload('yml', { targetFormat: 'json', save: 'false' })),
    ).toEqual({
      source: 'yaml',
      target: 'json',
      params: { source: 'yaml', target: 'json' },
    });
  });

  it.each([
    ['no target', {}],
    ['an unknown target', { targetFormat: 'toml' }],
    ['an uppercase target', { targetFormat: 'JSON' }],
    ['the source as target', { targetFormat: 'csv' }],
    ['save other than true/false', { targetFormat: 'json', save: 'yes' }],
  ])('refuses %s with 400', (_name, fields) => {
    expect(codeOf(() => op.resolve(upload('csv', fields)))).toBe('bad_request');
  });
});
