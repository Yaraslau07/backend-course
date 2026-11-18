import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import sharp from 'sharp';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/core/config/config.types';
import { RbacPermissionSeeds } from '@/modules/rbac/permission-seeds';

import { ip } from './utils/auth';
import { createTestApp } from './utils/create-test-app';
import { LogCapture } from './utils/log-capture';
import { type Actor, actorWithRoles, ensureBootstrapped } from './utils/rbac';

/** One capture for both apps in this file (nestjs-pino keeps the first root logger, D22). */
const logs = new LogCapture();
const sensitive: string[] = [];
let app: NestFastifyApplication;
let config: AppConfig;
let db: DataSource;
let temp: string;
let member: Actor;
let png: Buffer;
let jpeg: Buffer;

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const SVG = `<svg ${SVG_NS} width="200" height="100"><rect width="200" height="100" fill="#3a7"/></svg>`;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'c17-image-'));
  ({ app, config } = await createTestApp({
    logs,
    env: { TRANSFORMATION_TEMP_DIR: temp, IMAGE_SVG_MAX_BYTES: '4096' },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  await app.get(RbacPermissionSeeds).applyAll();
  member = await actorWithRoles(app, ['user']);
  png = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  jpeg = await sharp({
    create: { width: 30, height: 10, channels: 3, background: 'blue' },
  })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Copyright: 'secret-exif-owner' } },
    })
    .toBuffer();
});
afterAll(async () => {
  logs.expectNoLeaks(config, sensitive);
  await app.close();
  await rm(temp, { recursive: true, force: true });
});

type Part =
  | { field: string; value: string }
  | { file: string; name: string; type?: string; content: string | Buffer };

function multipart(parts: Part[]) {
  const boundary = `----c17${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('field' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.file}"; filename="${part.name}"\r\n` +
            `Content-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        Buffer.from(part.content),
        Buffer.from('\r\n'),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function convert(
  actor: Actor | undefined,
  name: string,
  content: string | Buffer,
  targetFormat: string,
  options: {
    options?: unknown;
    type?: string;
    extra?: Part[];
    on?: NestFastifyApplication;
    headers?: Record<string, string>;
  } = {},
) {
  const body = multipart([
    { field: 'targetFormat', value: targetFormat },
    ...(options.options === undefined
      ? []
      : [
          {
            field: 'options',
            value:
              typeof options.options === 'string'
                ? options.options
                : JSON.stringify(options.options),
          },
        ]),
    ...(options.extra ?? []),
    { file: 'file', name, type: options.type, content },
  ]);
  return (options.on ?? app).inject({
    method: 'POST',
    url: '/api/images/convert',
    cookies: actor?.cookies,
    payload: body.payload,
    headers: { ...body.headers, ...options.headers },
    remoteAddress: ip(),
  });
}

async function rows(userId: string) {
  return db.query<
    {
      type: string;
      source_format: string;
      target_format: string;
      status: string;
      error_code: string | null;
    }[]
  >(
    `SELECT type, source_format, target_format, status, error_code
       FROM transformations WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
}
const tempIsEmpty = async () => expect(await readdir(temp)).toEqual([]);

describe('GET /api/images/convert/formats (spec 2.2 §1.3.4)', () => {
  it('lists exactly the four pairs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/images/convert/formats',
      cookies: member.cookies,
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { source: 'png', target: ['jpeg'] },
      { source: 'jpeg', target: ['png'] },
      { source: 'svg', target: ['png', 'jpeg'] },
    ]);
  });

  it('401 without a session, 403 without transformations@convert', async () => {
    const outsider = await actorWithRoles(app, []);
    for (const [cookies, status] of [
      [undefined, 401],
      [outsider.cookies, 403],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/images/convert/formats',
        cookies,
        remoteAddress: ip(),
      });
      expect(res.statusCode).toBe(status);
    }
  });
});

describe('POST /api/images/convert: the four pairs (spec 2.2 §1.3.1)', () => {
  it('png → jpeg: alpha mixed with #ffffff, JPEG headers, history row', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const res = await convert(actor, 'photo.png', png, 'jpeg', {
      type: 'image/png',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="converted.jpeg"',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const out = res.rawPayload;
    expect(await sharp(out).metadata()).toMatchObject({
      format: 'jpeg',
      width: 40,
      height: 20,
    });
    const { data } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.min(data[0], data[1], data[2])).toBeGreaterThan(245);
    expect(await rows(actor.id)).toEqual([
      {
        type: 'image',
        source_format: 'png',
        target_format: 'jpeg',
        status: 'success',
        error_code: null,
      },
    ]);
    await tempIsEmpty();
  });

  it('jpeg → png: orientation applied, no EXIF in the result', async () => {
    const res = await convert(member, 'photo.jpg', jpeg, 'png', {
      type: 'image/jpeg',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 10, height: 30 });
    expect(meta.exif).toBeUndefined();
    expect(res.rawPayload.includes('secret-exif-owner')).toBe(false);
  });

  it('svg → png at its intrinsic size; svg → jpeg with options', async () => {
    const asPng = await convert(member, 'logo.svg', SVG, 'png', {
      type: 'image/svg+xml',
    });
    expect(asPng.statusCode).toBe(200);
    expect(await sharp(asPng.rawPayload).metadata()).toMatchObject({
      format: 'png',
      width: 200,
      height: 100,
    });
    const asJpeg = await convert(member, 'logo.svg', SVG, 'jpeg', {
      options: { width: 400, quality: 70, background: '#000000' },
    });
    expect(asJpeg.statusCode).toBe(200);
    expect(await sharp(asJpeg.rawPayload).metadata()).toMatchObject({
      format: 'jpeg',
      width: 400,
      height: 200,
    });
    expect(asJpeg.body).not.toContain('<svg');
  });

  it('svg sizes: none → 1024×1024; both → exactly that (D73)', async () => {
    const plain = await convert(
      member,
      'plain.svg',
      `<svg ${SVG_NS}><rect width="5" height="5"/></svg>`,
      'png',
    );
    expect(await sharp(plain.rawPayload).metadata()).toMatchObject({
      width: 1024,
      height: 1024,
    });
    const exact = await convert(member, 'logo.svg', SVG, 'png', {
      options: { width: 64, height: 64 },
    });
    expect(await sharp(exact.rawPayload).metadata()).toMatchObject({
      width: 64,
      height: 64,
    });
  });
});

describe('POST /api/images/convert: refusals (spec 2.2 §1.4)', () => {
  it('403 before parsing without the permission; 403 for a cross-origin write', async () => {
    const outsider = await actorWithRoles(app, []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/images/convert',
      cookies: outsider.cookies,
      payload: 'garbage',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(403);
    expect(
      (
        await convert(member, 'a.png', png, 'jpeg', {
          headers: { origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await convert(undefined, 'a.png', png, 'jpeg')).statusCode).toBe(
      401,
    );
  });

  it.each([
    ['a script', '<script>alert(document.cookie)</script>'],
    [
      'foreignObject',
      '<foreignObject><p xmlns="http://www.w3.org/1999/xhtml">x</p></foreignObject>',
    ],
    ['an onload handler', '<rect width="5" height="5" onload="evil()"/>'],
    [
      'an external image',
      '<image href="https://evil.test/x.png" width="5" height="5"/>',
    ],
    [
      'an external url() fill',
      '<rect width="5" height="5" fill="url(https://evil.test/#p)"/>',
    ],
  ])(
    'an SVG with %s: 400 invalid_file, history unsafe_input',
    async (_name, body) => {
      const actor = await actorWithRoles(app, ['user']);
      const text = `<svg ${SVG_NS} width="10" height="10">${body}</svg>`;
      sensitive.push(body);
      const res = await convert(actor, 'evil.svg', text, 'png');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_file' });
      expect((await rows(actor.id))[0]).toMatchObject({
        status: 'error',
        error_code: 'unsafe_input',
      });
      await tempIsEmpty();
    },
  );

  it('an SVG with a DTD and an animated PNG are refused (unsafe_input)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const xxe = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${SVG_NS}>&x;</svg>`;
    expect((await convert(actor, 'xxe.svg', xxe, 'png')).statusCode).toBe(400);
    const apng = await readFile(
      join(__dirname, 'fixtures/animated-profile.png'),
    );
    expect((await convert(actor, 'anim.png', apng, 'jpeg')).statusCode).toBe(
      400,
    );
    expect((await rows(actor.id)).map((r) => r.error_code)).toEqual([
      'unsafe_input',
      'unsafe_input',
    ]);
  });

  it('a damaged file is 400; content of another format is 415', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const broken = Buffer.concat([jpeg.subarray(0, 40), Buffer.alloc(300, 7)]);
    expect((await convert(actor, 'broken.jpg', broken, 'png')).statusCode).toBe(
      400,
    );
    expect((await convert(actor, 'fake.png', jpeg, 'jpeg')).statusCode).toBe(
      415,
    );
    expect((await rows(actor.id)).map((r) => r.error_code)).toEqual([
      'invalid_input',
      'content_mismatch',
    ]);
  });

  it('a result over 4096 px per side is 413 with history result_too_large (D73)', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const res = await convert(
      actor,
      'wide.svg',
      `<svg ${SVG_NS} width="5000" height="10"/>`,
      'png',
    );
    expect(res.statusCode).toBe(413);
    expect((await rows(actor.id))[0]).toMatchObject({
      error_code: 'result_too_large',
    });
  });

  it.each([
    ['png → svg', 'a.png', 'svg', {}, 415],
    ['png → png', 'a.png', 'png', {}, 415],
    ['png → gif', 'a.png', 'gif', {}, 415],
    ['a gif upload', 'a.gif', 'png', {}, 415],
    [
      'a MIME type that contradicts the extension',
      'a.png',
      'jpeg',
      { type: 'image/jpeg' },
      415,
    ],
    ['options that are not JSON', 'a.png', 'jpeg', { options: '{' }, 400],
    ['an unknown option', 'a.png', 'jpeg', { options: { dpi: 72 } }, 400],
    [
      'width for a PNG source',
      'a.png',
      'jpeg',
      { options: { width: 10 } },
      400,
    ],
    [
      'quality for a PNG result',
      'a.svg',
      'png',
      { options: { quality: 80 } },
      400,
    ],
    ['quality out of range', 'a.png', 'jpeg', { options: { quality: 0 } }, 400],
    [
      'a bad background',
      'a.png',
      'jpeg',
      { options: { background: 'white' } },
      400,
    ],
    ['width over 4096', 'a.svg', 'png', { options: { width: 4097 } }, 400],
    [
      'a bad save flag',
      'a.png',
      'jpeg',
      { extra: [{ field: 'save', value: 'maybe' }] },
      400,
    ],
    [
      'an extra field',
      'a.png',
      'jpeg',
      { extra: [{ field: 'resize', value: '1' }] },
      400,
    ],
    [
      'an SVG over its input limit',
      'big.svg',
      'png',
      { content: `<svg ${SVG_NS}>${'<g/>'.repeat(2000)}</svg>` },
      413,
    ],
  ])(
    '%s: %d, no history row (D65)',
    async (_name, name, target, options, status) => {
      const actor = await actorWithRoles(app, ['user']);
      const { content, ...rest } = options as { content?: string };
      const file = content ?? (name.endsWith('.svg') ? SVG : png);
      const res = await convert(actor, name, file, target, rest);
      expect(res.statusCode).toBe(status);
      expect(await rows(actor.id)).toEqual([]);
      await tempIsEmpty();
    },
  );

  it('logs formats, sizes and the result, never the SVG text or the file name', async () => {
    const marker = `secret-text-${randomUUID()}`;
    const name = `private-${randomUUID()}.svg`;
    sensitive.push(marker, name);
    const res = await convert(
      member,
      name,
      `<svg ${SVG_NS} width="10" height="10"><desc>${marker}</desc></svg>`,
      'png',
    );
    expect(res.statusCode).toBe(200);
    expect(
      logs
        .lines()
        .some(
          (line) =>
            line.event === 'transformation' &&
            line.type === 'image' &&
            line.sourceFormat === 'svg' &&
            line.transformationId === res.headers['x-transformation-id'],
        ),
    ).toBe(true);
  });
});

describe('the 30-second timeout (spec 2.2 §1.1, §1.4)', () => {
  let slow: NestFastifyApplication;

  beforeAll(async () => {
    ({ app: slow } = await createTestApp({
      logs,
      env: { TRANSFORMATION_TEMP_DIR: temp, IMAGE_CONVERSION_TIMEOUT_MS: '1' },
    }));
  });
  afterAll(() => slow.close());

  it('a conversion past the configured timeout is 504 with a timeout history row', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const res = await convert(actor, 'a.png', png, 'jpeg', { on: slow });
    expect(res.statusCode).toBe(504);
    expect((await rows(actor.id))[0]).toMatchObject({
      status: 'error',
      error_code: 'timeout',
    });
    await tempIsEmpty();
  });
});
