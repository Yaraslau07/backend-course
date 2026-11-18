import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import {
  convertImage,
  ImageConversionError,
  type ImageOptions,
  type ImageSource,
  type ImageTarget,
} from './image-formats';

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (
  attrs: string,
  body = '<rect width="10" height="10" fill="red"/>',
) => Buffer.from(`<svg ${SVG_NS} ${attrs}>${body}</svg>`);

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof ImageConversionError
      ? error.code
      : `other:${String(error)}`;
  }
  return 'none';
};
const convert = (
  source: ImageSource,
  target: ImageTarget,
  bytes: Buffer,
  options: ImageOptions = {},
) => convertImage(source, target, bytes, options);

/** A 40×20 PNG whose every pixel is fully transparent red. */
const transparentPng = () =>
  sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
/** A 30×10 JPEG tagged "rotate 90°" (orientation 6) with a private EXIF field. */
const orientedJpeg = () =>
  sharp({ create: { width: 30, height: 10, channels: 3, background: 'blue' } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Copyright: 'secret-exif-owner' } },
    })
    .toBuffer();
const pixel = async (bytes: Buffer) => {
  const { data } = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
};

describe('PNG → JPEG (spec 2.2 user story 1)', () => {
  it('mixes alpha with the background (#ffffff by default) and encodes JPEG', async () => {
    const out = await convert('png', 'jpeg', await transparentPng());
    const meta = await sharp(out.bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 40, height: 20 });
    expect(out).toMatchObject({ width: 40, height: 20 });
    const [r, g, b] = await pixel(out.bytes);
    expect(Math.min(r, g, b)).toBeGreaterThan(245);
  });

  it('uses the requested background and quality', async () => {
    const png = await transparentPng();
    const black = await convert('png', 'jpeg', png, { background: '#000000' });
    expect(Math.max(...(await pixel(black.bytes)))).toBeLessThan(10);
    const noisy = await sharp({
      create: { width: 200, height: 200, channels: 3, background: 'white' },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg ${SVG_NS} width="200" height="200"><circle cx="100" cy="100" r="80" fill="#3a7"/></svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
    const low = await convert('png', 'jpeg', noisy, { quality: 5 });
    const high = await convert('png', 'jpeg', noisy, { quality: 100 });
    expect(low.bytes.length).toBeLessThan(high.bytes.length);
  });

  it('refuses an animated PNG (D73) and a PNG larger than the result limit (413, D73)', async () => {
    const apng = await readFile(
      join(__dirname, '../../../test/fixtures/animated-profile.png'),
    );
    expect(await codeOf(() => convert('png', 'jpeg', apng))).toBe(
      'unsafe_input',
    );
    const wide = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    expect(await codeOf(() => convert('png', 'jpeg', wide))).toBe(
      'result_too_large',
    );
  });
});

describe('JPEG → PNG (spec 2.2 user story 2)', () => {
  it('applies the EXIF orientation, then drops all metadata', async () => {
    const out = await convert('jpeg', 'png', await orientedJpeg());
    const meta = await sharp(out.bytes).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 10, height: 30 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes('secret-exif-owner')).toBe(false);
  });

  it('PNG → JPEG also carries no metadata', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'red' },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Artist: 'secret-artist' } } })
      .toBuffer();
    const out = await convert('png', 'jpeg', png);
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
    expect(out.bytes.includes('secret-artist')).toBe(false);
  });
});

describe('content checks', () => {
  it('bytes of another format are content_mismatch; a damaged file is invalid_input', async () => {
    const jpeg = await orientedJpeg();
    const png = await transparentPng();
    expect(await codeOf(() => convert('png', 'jpeg', jpeg))).toBe(
      'content_mismatch',
    );
    expect(await codeOf(() => convert('jpeg', 'png', png))).toBe(
      'content_mismatch',
    );
    expect(
      await codeOf(() => convert('png', 'jpeg', Buffer.from('not an image'))),
    ).toBe('content_mismatch');
    const broken = Buffer.concat([jpeg.subarray(0, 40), Buffer.alloc(200, 7)]);
    expect(await codeOf(() => convert('jpeg', 'png', broken))).toBe(
      'invalid_input',
    );
  });
});

describe('SVG → PNG/JPEG (spec 2.2 user stories 3–4, §1.3.2)', () => {
  const size = async (bytes: Buffer, options: ImageOptions = {}) => {
    const out = await convert('svg', 'png', bytes, options);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([out.width, out.height]);
    return [out.width, out.height];
  };

  it('uses the intrinsic size: width/height, or the viewBox', async () => {
    expect(await size(svg('width="200" height="100"'))).toEqual([200, 100]);
    expect(await size(svg('viewBox="0 0 300 150"'))).toEqual([300, 150]);
  });

  it('without an intrinsic size it is 1024×1024 (also for percentages)', async () => {
    expect(await size(svg(''))).toEqual([1024, 1024]);
    expect(await size(svg('width="100%" height="100%"'))).toEqual([1024, 1024]);
  });

  it('one dimension keeps the aspect ratio; both give exactly that size (D73)', async () => {
    const wide = svg('width="200" height="100"');
    expect(await size(wide, { width: 400 })).toEqual([400, 200]);
    expect(await size(wide, { height: 50 })).toEqual([100, 50]);
    expect(await size(wide, { width: 300, height: 300 })).toEqual([300, 300]);
    expect(
      await size(svg('width="10" height="1000"'), { width: 4096, height: 2 }),
    ).toEqual([4096, 2]);
  });

  it('a result over 4096 px or 16,777,216 px is result_too_large (D73)', async () => {
    expect(await codeOf(() => size(svg('width="5000" height="10"')))).toBe(
      'result_too_large',
    );
    expect(
      await codeOf(() => size(svg('width="10" height="1000"'), { width: 100 })),
    ).toBe('result_too_large');
  });

  it('PNG keeps transparency; JPEG gets the background', async () => {
    const shape = svg(
      'width="20" height="20"',
      '<circle cx="15" cy="15" r="2" fill="red"/>',
    );
    const png = await convert('svg', 'png', shape);
    expect((await sharp(png.bytes).metadata()).hasAlpha).toBe(true);
    const jpeg = await convert('svg', 'jpeg', shape, {
      background: '#000000',
      quality: 90,
    });
    expect((await sharp(jpeg.bytes).metadata()).format).toBe('jpeg');
    expect(Math.max(...(await pixel(jpeg.bytes)))).toBeLessThan(15);
  });

  it.each([
    ['a script element', '<script>alert(1)</script>'],
    ['a script in another case', '<SCRIPT>alert(1)</SCRIPT>'],
    [
      'foreignObject',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    ],
    ['an event handler', '<rect width="5" height="5" onclick="evil()"/>'],
    [
      'an external image',
      '<image href="https://evil.test/x.png" width="5" height="5"/>',
    ],
    ['a local file image', '<image href="/etc/hosts" width="5" height="5"/>'],
    [
      'an xlink:href to a file',
      '<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="file:///etc/passwd"/>',
    ],
    [
      'a data URI image',
      '<image href="data:image/svg+xml;base64,PHN2Zy8+" width="5" height="5"/>',
    ],
    [
      'an external url() in a fill',
      '<rect width="5" height="5" fill="url(https://evil.test/#p)"/>',
    ],
    [
      'an external url() in a style attribute',
      '<rect width="5" height="5" style="fill:url(//evil.test/p)"/>',
    ],
    [
      'an @import in a style element',
      '<style>@import url("https://evil.test/x.css");</style>',
    ],
    [
      'a url() in a style element',
      '<style>rect{fill:url(http://evil.test/#g)}</style>',
    ],
    ['an external use', '<use href="https://evil.test/sprite.svg#icon"/>'],
  ])('refuses %s (unsafe_input)', async (_name, body) => {
    expect(
      await codeOf(() =>
        convert('svg', 'png', svg('width="10" height="10"', body)),
      ),
    ).toBe('unsafe_input');
  });

  it('allows internal references: #ids in href and url()', async () => {
    const body =
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>' +
      '<rect id="r" width="5" height="5"/></defs><use href="#r"/><rect width="5" height="5" fill="url(#g)"/>' +
      '<style>rect{fill:url( "#g" )}</style>';
    expect(await size(svg('width="10" height="10"', body))).toEqual([10, 10]);
  });

  it('refuses a DTD (unsafe_input), non-XML (invalid_input) and XML that is not SVG (content_mismatch)', async () => {
    expect(
      await codeOf(() =>
        convert(
          'svg',
          'png',
          Buffer.from(
            `<!DOCTYPE svg [<!ENTITY e "x">]><svg ${SVG_NS}>&e;</svg>`,
          ),
        ),
      ),
    ).toBe('unsafe_input');
    expect(
      await codeOf(() => convert('svg', 'png', Buffer.from('<svg><g></svg>'))),
    ).toBe('invalid_input');
    expect(
      await codeOf(() =>
        convert('svg', 'png', Buffer.from([0xff, 0xfe, 0x00])),
      ),
    ).toBe('invalid_input');
    expect(
      await codeOf(() =>
        convert('svg', 'png', Buffer.from('<html><body/></html>')),
      ),
    ).toBe('content_mismatch');
  });

  it('accepts an XML declaration, comments and a BOM before the root', async () => {
    const text = `\uFEFF<?xml version="1.0"?>\n<!-- <svg width="1"> -->\n<svg ${SVG_NS} width="12" height="6"/>`;
    expect(await size(Buffer.from(text))).toEqual([12, 6]);
  });
});
