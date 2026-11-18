import { AppException } from '@/core/errors/app.exception';

import { imageOperation, parseImageOptions } from './image-operation';

const op = imageOperation({ png: 10, jpeg: 20, svg: 30 }, 30_000);
const upload = (extension: string, fields: Record<string, string>) => ({
  file: { path: '/x', size: 1, extension, mime: 'image/png' },
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

describe('imageOperation() (spec 2.2 §1.3.1)', () => {
  it('takes file, targetFormat, options and save, with the largest limit as the parser cap', () => {
    expect(op.type).toBe('image');
    expect(op.fields).toEqual(['targetFormat', 'options', 'save']);
    expect(op.maxFileBytes).toBe(30);
  });

  it.each([
    ['png', 'image/png', 10],
    ['jpg', 'image/jpeg', 20],
    ['jpeg', 'image/jpg', 20],
    ['svg', 'image/svg+xml', 30],
    ['svg', 'application/octet-stream', 30],
    ['png', 'image/jpeg', null],
    ['svg', 'text/plain', null],
    ['gif', 'image/gif', null],
    ['webp', 'image/webp', null],
  ])('%s as %s → %p', (extension, mime, limit) => {
    expect(op.limitFor(extension, mime)).toBe(limit);
  });

  it('resolves the direction and passes options and the library timeout', () => {
    expect(
      op.resolve(
        upload('svg', {
          targetFormat: 'jpeg',
          options: '{"width":10,"quality":50}',
        }),
      ),
    ).toEqual({
      source: 'svg',
      target: 'jpeg',
      params: {
        source: 'svg',
        target: 'jpeg',
        options: { width: 10, quality: 50 },
        timeoutSeconds: 29,
      },
    });
    expect(
      imageOperation({ png: 1, jpeg: 1, svg: 1 }, 500).resolve(
        upload('png', { targetFormat: 'jpeg' }),
      ).params,
    ).toMatchObject({ timeoutSeconds: 1 });
  });

  it.each([
    ['png', { targetFormat: 'svg' }],
    ['png', { targetFormat: 'png' }],
    ['jpg', { targetFormat: 'jpeg' }],
    ['png', { targetFormat: 'gif' }],
  ])('%s → %p is an unsupported direction (415)', (extension, fields) => {
    expect(codeOf(() => op.resolve(upload(extension, fields)))).toBe(
      'unsupported_media_type',
    );
  });

  it('a missing target or a bad save flag is 400', () => {
    expect(codeOf(() => op.resolve(upload('png', {})))).toBe('bad_request');
    expect(
      codeOf(() =>
        op.resolve(upload('png', { targetFormat: 'jpeg', save: '1' })),
      ),
    ).toBe('bad_request');
  });
});

describe('parseImageOptions() (spec 2.2 §1.3.2)', () => {
  it('accepts the fields that apply, with their ranges', () => {
    expect(parseImageOptions(undefined, 'png', 'jpeg')).toEqual({});
    expect(parseImageOptions('{}', 'png', 'jpeg')).toEqual({});
    expect(
      parseImageOptions('{"quality":1,"background":"#AbCdEf"}', 'png', 'jpeg'),
    ).toEqual({ quality: 1, background: '#abcdef' });
    expect(
      parseImageOptions('{"width":4096,"height":1}', 'svg', 'png'),
    ).toEqual({
      width: 4096,
      height: 1,
    });
  });

  it.each([
    ['not JSON', '{', 'png', 'jpeg'],
    ['an array', '[1]', 'png', 'jpeg'],
    ['a string', '"x"', 'png', 'jpeg'],
    ['an unknown field', '{"dpi":72}', 'svg', 'png'],
    ['quality for a PNG result', '{"quality":80}', 'jpeg', 'png'],
    ['background for a PNG result', '{"background":"#000000"}', 'svg', 'png'],
    ['width for a raster source', '{"width":10}', 'png', 'jpeg'],
    ['quality 0', '{"quality":0}', 'png', 'jpeg'],
    ['quality 101', '{"quality":101}', 'png', 'jpeg'],
    ['a fractional quality', '{"quality":50.5}', 'png', 'jpeg'],
    ['a quality string', '{"quality":"80"}', 'png', 'jpeg'],
    ['width 0', '{"width":0}', 'svg', 'png'],
    ['width 4097', '{"width":4097}', 'svg', 'png'],
    ['a short colour', '{"background":"#fff"}', 'png', 'jpeg'],
    ['a named colour', '{"background":"white"}', 'png', 'jpeg'],
  ])('refuses %s with 400', (_name, raw, source, target) => {
    expect(
      codeOf(() =>
        parseImageOptions(raw, source as 'png' | 'jpeg' | 'svg', target),
      ),
    ).toBe('bad_request');
  });
});
