import { contentTypeOf, fileNameOf } from './stored-result';

describe('stored result naming (spec 2.4 §1.3.2)', () => {
  it.each([
    ['csv', 'text/csv; charset=utf-8'],
    ['json', 'application/json; charset=utf-8'],
    ['xml', 'application/xml; charset=utf-8'],
    ['yaml', 'application/yaml; charset=utf-8'],
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
  ])('%s is served as %s', (format, type) => {
    expect(contentTypeOf(format)).toBe(type);
    expect(fileNameOf(format)).toBe(`converted.${format}`);
  });

  it('serves a format it does not know as opaque bytes, never a guess', () => {
    for (const format of ['svg', 'upper', 'constructor', '__proto__'])
      expect(contentTypeOf(format)).toBe('application/octet-stream');
  });
});
