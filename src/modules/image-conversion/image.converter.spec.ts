import { Readable, Writable } from 'node:stream';

import sharp from 'sharp';

import { converter } from './image.converter';

function sink() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

describe('image converter (worker side)', () => {
  it('converts the whole input and reports the target type, extension and final size', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const out = sink();
    expect(
      await converter.convert(
        Readable.from([png.subarray(0, 10), png.subarray(10)]),
        { source: 'png', target: 'jpeg', options: {}, timeoutSeconds: 5 },
        out.stream,
      ),
    ).toEqual({
      ok: true,
      contentType: 'image/jpeg',
      extension: 'jpeg',
      width: 4,
      height: 4,
    });
    expect((await sharp(out.bytes()).metadata()).format).toBe('jpeg');
  });

  it('returns the image error code and writes nothing', async () => {
    const out = sink();
    expect(
      await converter.convert(
        Readable.from([
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
          ),
        ]),
        { source: 'svg', target: 'png', options: {}, timeoutSeconds: 5 },
        out.stream,
      ),
    ).toEqual({ ok: false, code: 'unsafe_input' });
    expect(out.bytes().length).toBe(0);
  });

  it('refuses parameters that are not one of the four directions', async () => {
    await expect(
      converter.convert(
        Readable.from([Buffer.from('x')]),
        { source: 'png', target: 'svg', options: {}, timeoutSeconds: 5 },
        sink().stream,
      ),
    ).rejects.toThrow();
  });
});
