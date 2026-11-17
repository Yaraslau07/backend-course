import sharp from 'sharp';

import { PhotoNormalizer } from './photo-normalizer';

describe('bounded normalized profile photos', () => {
  const normalizer = new PhotoNormalizer();
  const create = (width = 128, height = 64) =>
    sharp({ create: { width, height, channels: 3, background: '#f00' } });

  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodes %s, preserves aspect ratio and strips metadata',
    async (format) => {
      const bytes = await create(2048, 1024)
        .withMetadata({ orientation: 6 })
        .toFormat(format)
        .toBuffer();
      const output = await normalizer.normalize({
        bytes,
        mime: `image/${format}`,
      });
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width, meta.height)).toBe(1024);
      expect(Math.min(meta.width, meta.height)).toBe(512);
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(output.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    },
  );
  it('does not enlarge a small valid image', async () => {
    const bytes = await create().png().toBuffer();
    const output = await normalizer.normalize({ bytes, mime: 'image/png' });
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height]).toEqual([128, 64]);
  });
  it.each([
    [63, 64],
    [64, 63],
    [4097, 64],
  ])('rejects invalid dimensions %j', async (width, height) => {
    const bytes = await create(width, height).png().toBuffer();
    await expect(
      normalizer.normalize({ bytes, mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('rejects animation even when the first frame is valid', async () => {
    const png = await create().png().toBuffer();
    const bytes = await sharp([png, png], { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    await expect(
      normalizer.normalize({ bytes, mime: 'image/webp' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('rejects MIME/signature mismatch, unsupported types, corruption and encoded oversize', async () => {
    const png = await create().png().toBuffer();
    await expect(
      normalizer.normalize({ bytes: png, mime: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
    await expect(
      normalizer.normalize({
        bytes: Buffer.from('<svg/>'),
        mime: 'image/svg+xml',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
    await expect(
      normalizer.normalize({ bytes: png.subarray(0, 20), mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      normalizer.normalize({
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
        mime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
  });
});
