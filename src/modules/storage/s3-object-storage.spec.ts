import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@/core/config/config.service';
import { S3ObjectStorage } from './s3-object-storage';

const values: Record<string, unknown> = {
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'test-bucket',
  S3_PREFIX: 'photos/',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_FORCE_PATH_STYLE: false,
};
describe('S3 storage boundary', () => {
  let storage: S3ObjectStorage;
  let send: jest.SpyInstance;
  beforeEach(() => {
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    storage = new S3ObjectStorage({
      get: (key: string) => values[key],
    } as ConfigService);
  });
  afterEach(() => {
    storage.onModuleDestroy();
    jest.restoreAllMocks();
  });
  it('prefixes writes, uses a WebP content type and refuses overwrites', async () => {
    expect(await storage.write('opaque.webp', Buffer.from('bytes'))).toBe(
      'stored',
    );
    const command = (send.mock.calls as unknown[][])[0][0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'photos/opaque.webp',
      ContentType: 'image/webp',
      IfNoneMatch: '*',
    });
  });
  it('takes a content type, and a repeated write of the same key is stored again', async () => {
    expect(
      await storage.write(
        'opaque',
        Buffer.from('x'),
        'text/csv; charset=utf-8',
      ),
    ).toBe('stored');
    expect(
      ((send.mock.calls as unknown[][])[0][0] as { input: unknown }).input,
    ).toMatchObject({ ContentType: 'text/csv; charset=utf-8' });
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } });
    expect(await storage.write('opaque', Buffer.from('x'))).toBe('stored');
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 500 } });
    expect(await storage.write('opaque', Buffer.from('x'))).toBe('unavailable');
  });
  it('returns a stream without buffering an object', async () => {
    const stream = Readable.from('photo');
    send.mockResolvedValue({ Body: stream });
    expect(await storage.read('opaque.webp')).toEqual({
      kind: 'found',
      stream,
    });
    stream.destroy();
    send.mockResolvedValue({});
    expect(await storage.read('opaque.webp')).toEqual({ kind: 'unavailable' });
  });
  it.each(['NoSuchKey', 'NotFound', 'AccessDenied', 'AbortError'])(
    'maps %s without exposing transport details',
    async (name) => {
      send.mockRejectedValue(
        Object.assign(new Error('private path and credentials'), { name }),
      );
      expect(await storage.read('opaque')).toEqual({
        kind:
          name === 'NoSuchKey' || name === 'NotFound'
            ? 'not_found'
            : 'unavailable',
      });
      expect(await storage.write('opaque', Buffer.alloc(1))).toBe(
        'unavailable',
      );
      expect(await storage.delete('opaque')).toBe('unavailable');
      expect(await storage.list()).toEqual({ kind: 'unavailable' });
    },
  );
  it('makes deletion idempotent and bounds paginated listings to its prefix', async () => {
    expect(await storage.delete('opaque')).toBe('deleted');
    const date = new Date();
    send.mockResolvedValue({
      Contents: [
        { Key: 'photos/opaque.webp', LastModified: date },
        { Key: 'elsewhere/private', LastModified: date },
        { Key: 'photos/../escape', LastModified: date },
        { Key: 'photos/missing-date' },
      ],
      NextContinuationToken: 'next',
    });
    expect(await storage.list('prior')).toEqual({
      kind: 'listed',
      objects: [{ key: 'opaque.webp', modifiedAt: date }],
      cursor: 'next',
    });
    const command = (send.mock.calls as unknown[][]).at(-1)![0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      Prefix: 'photos/',
      MaxKeys: 100,
      ContinuationToken: 'prior',
    });
    send.mockResolvedValue({});
    expect(await storage.list()).toEqual({ kind: 'listed', objects: [] });
  });
  it('rejects invalid keys without calling S3', async () => {
    for (const key of ['../escape', 'with/slash', 'key\n']) {
      expect(await storage.read(key)).toEqual({ kind: 'unavailable' });
      expect(await storage.write(key, Buffer.alloc(1))).toBe('unavailable');
      expect(await storage.delete(key)).toBe('unavailable');
    }
    expect(send).not.toHaveBeenCalled();
  });
});
