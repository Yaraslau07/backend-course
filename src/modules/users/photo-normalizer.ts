import { Injectable } from '@nestjs/common';

export interface PhotoInput {
  bytes: Buffer;
  mime: string;
}

@Injectable()
export class PhotoNormalizer {
  normalize(input: PhotoInput): Promise<Buffer> {
    void input;
    throw new Error('not implemented');
  }
}
