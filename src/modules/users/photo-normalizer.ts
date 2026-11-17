import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

import { AppException } from '@/core/errors/app.exception';

export interface PhotoInput {
  bytes: Buffer;
  mime: string;
}
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

@Injectable()
export class PhotoNormalizer {
  async normalize({ bytes, mime }: PhotoInput): Promise<Buffer> {
    if (bytes.length > PHOTO_MAX_BYTES)
      throw new AppException('payload_too_large');
    const format = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'webp'
          : null;
    if (!format || mime !== `image/${format}`)
      throw new AppException('unsupported_media_type');
    // libvips may read only the default image of APNG, so reject its animation chunk explicitly.
    if (format === 'png') {
      for (let at = 8; at + 12 <= bytes.length; ) {
        const length = bytes.readUInt32BE(at);
        if (bytes.toString('ascii', at + 4, at + 8) === 'acTL')
          throw new AppException('bad_request');
        at += 12 + length;
      }
    }
    try {
      const image = sharp(bytes, {
        limitInputPixels: 4096 * 4096,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (
        metadata.format !== format ||
        (metadata.pages ?? 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width < 64 ||
        metadata.height < 64 ||
        metadata.width > 4096 ||
        metadata.height > 4096
      )
        throw new AppException('bad_request');
      const result = await image
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .timeout({ seconds: 10 })
        .toBuffer();
      if (result.length > OUTPUT_MAX_BYTES)
        throw new AppException('bad_request');
      return result;
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw new AppException('bad_request');
    }
  }
}
