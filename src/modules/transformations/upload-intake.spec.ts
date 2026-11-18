import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { FastifyRequest } from 'fastify';

import type { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';
import type { ReadinessRegistry } from '@/core/health/readiness.registry';

import { TempArea } from './temp-area';
import { extensionOf, readUpload, type UploadRules } from './upload-intake';

type Part =
  | {
      type: 'field';
      fieldname: string;
      value: unknown;
      valueTruncated?: boolean;
    }
  | {
      type: 'file';
      fieldname: string;
      filename: string;
      mimetype: string;
      file: Readable & { truncated?: boolean };
    };

const file = (
  content: string | Buffer,
  name = 'a.csv',
  fieldname = 'file',
): Part => ({
  type: 'file',
  fieldname,
  filename: name,
  mimetype: 'text/csv',
  file: Readable.from([Buffer.from(content)]),
});
const field = (fieldname: string, value: unknown = 'x'): Part => ({
  type: 'field',
  fieldname,
  value,
});
function request(parts: Part[] | Error, multipart = true) {
  return {
    isMultipart: () => multipart,
    parts: () =>
      (async function* () {
        await Promise.resolve();
        if (parts instanceof Error) throw parts;
        for (const part of parts) yield part;
      })(),
  } as unknown as FastifyRequest;
}
const rules: UploadRules = {
  fields: ['targetFormat'],
  maxFileBytes: 100,
  limitFor: (extension) => (extension === 'csv' ? 10 : null),
};

let temp: TempArea;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c15-intake-'));
  temp = new TempArea(
    { get: () => root } as unknown as ConfigService,
    { register: () => undefined } as unknown as ReadinessRegistry,
  );
  await temp.onModuleInit();
});
afterAll(() => rm(root, { recursive: true, force: true }));

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};

describe('extensionOf()', () => {
  it.each([
    ['report.CSV', 'csv'],
    ['a.b.yaml', 'yaml'],
    ['noext', ''],
    ['../../etc/passwd', ''],
    ['x.toolongextension', ''],
    [undefined, ''],
  ])('%p → %p', (name, extension) => {
    expect(extensionOf(name)).toBe(extension);
  });
});

describe('readUpload() (spec 2.0 §1.3.2 step 4)', () => {
  it('stores the file under a random name and returns the allowed fields', async () => {
    const upload = await readUpload(
      request([field('targetFormat', 'json'), file('a,b', 'secret.csv')]),
      temp,
      rules,
    );
    expect(upload.fields).toEqual({ targetFormat: 'json' });
    expect(upload.file).toMatchObject({
      size: 3,
      extension: 'csv',
      mime: 'text/csv',
    });
    expect(upload.file.path).not.toContain('secret');
    expect(await readFile(upload.file.path, 'utf8')).toBe('a,b');
    await temp.remove(upload.file.path);
  });

  it.each([
    ['not multipart', request([], false), 'unsupported_media_type'],
    ['no file', request([field('targetFormat')]), 'bad_request'],
    ['an unknown field', request([field('evil'), file('a')]), 'bad_request'],
    [
      'a repeated field',
      request([field('targetFormat'), field('targetFormat'), file('a')]),
      'bad_request',
    ],
    [
      'a non-string field',
      request([field('targetFormat', 1), file('a')]),
      'bad_request',
    ],
    [
      'a truncated field',
      request([
        { ...field('targetFormat'), valueTruncated: true } as Part,
        file('a'),
      ]),
      'bad_request',
    ],
    [
      'a file under another name',
      request([file('a', 'a.csv', 'upload')]),
      'bad_request',
    ],
    ['two files', request([file('a'), file('b')]), 'bad_request'],
    [
      'an unsupported extension',
      request([file('a', 'a.exe')]),
      'unsupported_media_type',
    ],
    ['an empty file', request([file('')]), 'bad_request'],
    [
      'a file over its format limit',
      request([file('12345678901')]),
      'payload_too_large',
    ],
    [
      'the parser size limit',
      request(
        Object.assign(new Error('x'), { code: 'FST_REQ_FILE_TOO_LARGE' }),
      ),
      'payload_too_large',
    ],
    [
      'a malformed body',
      request(Object.assign(new Error('x'), { code: 'FST_PARTS_LIMIT' })),
      'bad_request',
    ],
  ])('refuses %s, leaving nothing behind', async (_name, req, code) => {
    expect(await codeOf(() => readUpload(req, temp, rules))).toBe(code);
    expect(await readdir(root)).toEqual([]);
  });

  it('a stream the parser truncated is 413', async () => {
    const part = file('abc') as Extract<Part, { type: 'file' }>;
    part.file.truncated = true;
    expect(await codeOf(() => readUpload(request([part]), temp, rules))).toBe(
      'payload_too_large',
    );
    expect(await readdir(root)).toEqual([]);
  });
});
