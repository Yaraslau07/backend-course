import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { XMLParser } from 'fast-xml-parser';
import { DataSource } from 'typeorm';
import YAML from 'yaml';

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

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
});

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'c16-text-'));
  ({ app, config } = await createTestApp({
    logs,
    env: { TRANSFORMATION_TEMP_DIR: temp, TEXT_YAML_MAX_BYTES: '2048' },
  }));
  db = app.get(DataSource);
  await ensureBootstrapped(app);
  await app.get(RbacPermissionSeeds).applyAll();
  member = await actorWithRoles(app, ['user']);
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
  const boundary = `----c16${randomUUID()}`;
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

function post(
  target: NestFastifyApplication,
  actor: Actor | undefined,
  parts: Part[],
  headers: Record<string, string> = {},
) {
  const body = multipart(parts);
  return target.inject({
    method: 'POST',
    url: '/api/convert',
    cookies: actor?.cookies,
    payload: body.payload,
    headers: { ...body.headers, ...headers },
    remoteAddress: ip(),
  });
}
const convert = (
  actor: Actor,
  name: string,
  content: string | Buffer,
  targetFormat: string,
  options: { type?: string; extra?: Part[]; on?: NestFastifyApplication } = {},
) =>
  post(options.on ?? app, actor, [
    { field: 'targetFormat', value: targetFormat },
    ...(options.extra ?? []),
    { file: 'file', name, type: options.type, content },
  ]);

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

const TABLE = [
  { name: 'Ada', city: 'Zürich, CH' },
  { name: '"Bob"', city: 'Москва' },
];
const SOURCES: Record<string, { name: string; content: string; type: string }> =
  {
    csv: {
      name: 'people.csv',
      content: 'name,city\nAda,"Zürich, CH"\n"""Bob""",Москва\n',
      type: 'text/csv',
    },
    json: {
      name: 'people.json',
      content: JSON.stringify(TABLE),
      type: 'application/json',
    },
    xml: {
      name: 'people.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><rows><row><name>Ada</name><city>Zürich, CH</city></row>' +
        '<row><name>"Bob"</name><city>Москва</city></row></rows>',
      type: 'application/xml',
    },
    yaml: {
      name: 'people.yml',
      content: YAML.stringify(TABLE),
      type: 'application/yaml',
    },
  };
/** What each target should hold, read back with its own library. */
const READ: Record<string, (body: string) => unknown> = {
  csv: (body) => body,
  json: (body) => JSON.parse(body) as unknown,
  yaml: (body) => YAML.parse(body) as unknown,
  xml: (body) => xml.parse(body) as unknown,
};
const EXPECTED: Record<string, unknown> = {
  csv: SOURCES.csv.content,
  json: TABLE,
  yaml: TABLE,
  xml: { rows: { row: TABLE } },
};
const TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
};

describe('GET /api/convert/formats (spec 2.1 §1.3.3)', () => {
  it('lists four sources with three targets each', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/convert/formats',
      cookies: member.cookies,
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { source: 'csv', target: ['json', 'xml', 'yaml'] },
      { source: 'json', target: ['csv', 'xml', 'yaml'] },
      { source: 'xml', target: ['csv', 'json', 'yaml'] },
      { source: 'yaml', target: ['csv', 'json', 'xml'] },
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
        url: '/api/convert/formats',
        cookies,
        remoteAddress: ip(),
      });
      expect(res.statusCode).toBe(status);
    }
  });
});

describe('POST /api/convert: twelve directions (spec 2.1 §1.3.1)', () => {
  const directions = Object.keys(SOURCES).flatMap((source) =>
    Object.keys(SOURCES)
      .filter((target) => target !== source)
      .map((target) => [source, target] as const),
  );

  it.each(directions)('%s → %s', async (source, target) => {
    const actor = await actorWithRoles(app, ['user']);
    const input = SOURCES[source];
    const res = await convert(actor, input.name, input.content, target, {
      type: input.type,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(TYPES[target]);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="converted.${target}"`,
    );
    expect(READ[target](res.body)).toEqual(EXPECTED[target]);
    const [row] = await rows(actor.id);
    expect(row).toEqual({
      type: 'file',
      source_format: source,
      target_format: target,
      status: 'success',
      error_code: null,
    });
    expect(res.headers['x-transformation-id']).toEqual(expect.any(String));
    await tempIsEmpty();
  });

  it('JSON ↔ YAML keeps types; XML ↔ JSON uses @attributes, #text and arrays', async () => {
    const typed = { a: 1, b: true, c: null, d: [1.5, 'x'], e: '007' };
    const yaml = await convert(
      member,
      'typed.json',
      JSON.stringify(typed),
      'yaml',
    );
    expect(YAML.parse(yaml.body)).toEqual(typed);
    const order = await convert(
      member,
      'order.xml',
      '<order id="7"><item>a</item><item>b</item><note lang="en">hi</note></order>',
      'json',
    );
    expect(order.json()).toEqual({
      order: {
        '@id': '7',
        item: ['a', 'b'],
        note: { '@lang': 'en', '#text': 'hi' },
      },
    });
    const back = await convert(member, 'order.json', order.body, 'xml');
    expect(xml.parse(back.body)).toEqual(order.json());
  });

  it('accepts a UTF-8 BOM and the save flag (stored in spec 2.4)', async () => {
    const res = await convert(member, 'bom.csv', '﻿a\n1\n', 'json', {
      extra: [{ field: 'save', value: 'false' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ a: '1' }]);
  });
});

describe('POST /api/convert: refusals (spec 2.1 §1.4)', () => {
  it('401 without a session; 403 without the permission, before the body is read', async () => {
    expect(
      (await post(app, undefined, [{ field: 'targetFormat', value: 'json' }]))
        .statusCode,
    ).toBe(401);
    const outsider = await actorWithRoles(app, []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert',
      cookies: outsider.cookies,
      payload: 'garbage',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      remoteAddress: ip(),
    });
    expect(res.statusCode).toBe(403);
    expect(
      (
        await post(app, member, [{ field: 'targetFormat', value: 'json' }], {
          origin: 'https://evil.example',
        })
      ).statusCode,
    ).toBe(403);
  });

  it.each([
    ['invalid CSV', 'bad.csv', 'a,b\n"1,2\n', 'json', 'invalid_input'],
    [
      'a CSV header XML cannot hold',
      'h.csv',
      'first name\nAda\n',
      'xml',
      'structure_mismatch',
    ],
    [
      'JSON that is not a table',
      'obj.json',
      '{"a":{"b":1}}',
      'csv',
      'structure_mismatch',
    ],
    [
      'JSON without a single root',
      'arr.json',
      '[1,2]',
      'xml',
      'structure_mismatch',
    ],
    ['broken JSON', 'broken.json', '{"a":', 'yaml', 'invalid_input'],
    [
      'XML with a DTD (XXE)',
      'xxe.xml',
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
      'json',
      'unsafe_input',
    ],
    ['malformed XML', 'm.xml', '<a><b></a>', 'json', 'invalid_input'],
    [
      'XML that is not rows/row',
      'u.xml',
      '<users><user><a>1</a></user></users>',
      'csv',
      'structure_mismatch',
    ],
    [
      'YAML with an unsafe tag',
      't.yaml',
      'a: !!python/object:os.system ls\n',
      'json',
      'invalid_input',
    ],
    [
      'bytes that are not UTF-8',
      'latin.csv',
      Buffer.from([0x61, 0x0a, 0xe9, 0x0a]),
      'json',
      'invalid_input',
    ],
  ])(
    '%s: 400 invalid_file, history error %s',
    async (_name, name, content, target, code) => {
      const actor = await actorWithRoles(app, ['user']);
      sensitive.push(
        ...(typeof content === 'string' && content.length > 12
          ? [content]
          : []),
      );
      const res = await convert(actor, name, content, target);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_file' });
      expect(res.body).not.toMatch(/passwd|python|Unexpected|line \d/);
      expect((await rows(actor.id))[0]).toMatchObject({
        status: 'error',
        error_code: code,
      });
      await tempIsEmpty();
    },
  );

  it.each([
    ['an empty file', 'e.csv', '', 'json', {}, 400],
    ['an unknown target', 'a.csv', 'a\n1\n', 'toml', {}, 400],
    ['the source as target', 'a.csv', 'a\n1\n', 'csv', {}, 400],
    [
      'save that is not true/false',
      'a.csv',
      'a\n1\n',
      'json',
      { extra: [{ field: 'save', value: 'yes' }] },
      400,
    ],
    [
      'an extra field',
      'a.csv',
      'a\n1\n',
      'json',
      { extra: [{ field: 'delimiter', value: ';' }] },
      400,
    ],
    ['an unsupported extension', 'a.txt', 'a\n1\n', 'json', {}, 415],
    [
      'a MIME type that contradicts the extension',
      'a.json',
      '{}',
      'yaml',
      { type: 'image/png' },
      415,
    ],
    [
      'an input over its format limit',
      'big.yaml',
      `a: "${'x'.repeat(3000)}"\n`,
      'json',
      {},
      413,
    ],
  ])(
    '%s: %d, no history row (D65)',
    async (_name, name, content, target, options, status) => {
      const actor = await actorWithRoles(app, ['user']);
      const res = await convert(actor, name, content, target, options);
      expect(res.statusCode).toBe(status);
      expect(await rows(actor.id)).toEqual([]);
      await tempIsEmpty();
    },
  );

  it('a result over 50 MiB is 413 and nothing partial is returned', async () => {
    const actor = await actorWithRoles(app, ['user']);
    // Long column names repeat in every JSON object: ~600 KB of CSV becomes > 50 MiB of JSON.
    const header = Array.from(
      { length: 100 },
      (_, i) => `column_${i}_${'n'.repeat(190)}`,
    );
    const line = Array(100).fill('a').join(',');
    const csv = `${header.join(',')}\n${Array(3000).fill(line).join('\n')}\n`;
    const res = await convert(actor, 'wide.csv', csv, 'json');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'payload_too_large' });
    expect((await rows(actor.id))[0]).toMatchObject({
      status: 'error',
      error_code: 'result_too_large',
    });
    await tempIsEmpty();
  });

  it('logs formats, sizes and the result, never the content or the file name', async () => {
    const secret = `secret-${randomUUID()}`;
    const name = `private-${randomUUID()}.csv`;
    sensitive.push(secret, name);
    const res = await convert(member, name, `value\n${secret}\n`, 'yaml');
    expect(res.statusCode).toBe(200);
    expect(
      logs
        .lines()
        .some(
          (line) =>
            line.event === 'transformation' &&
            line.sourceFormat === 'csv' &&
            line.targetFormat === 'yaml' &&
            line.transformationId === res.headers['x-transformation-id'],
        ),
    ).toBe(true);
  });
});

describe('the 30-second timeout (spec 2.1 §1.1, §1.4)', () => {
  let slow: NestFastifyApplication;

  beforeAll(async () => {
    ({ app: slow } = await createTestApp({
      logs,
      env: { TRANSFORMATION_TEMP_DIR: temp, TEXT_CONVERSION_TIMEOUT_MS: '1' },
    }));
  });
  afterAll(() => slow.close());

  it('a conversion past the configured timeout is 504 with a timeout history row', async () => {
    const actor = await actorWithRoles(app, ['user']);
    const res = await convert(actor, 'a.csv', 'a\n1\n', 'json', { on: slow });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: 'gateway_timeout' });
    expect((await rows(actor.id))[0]).toMatchObject({
      status: 'error',
      error_code: 'timeout',
    });
    await tempIsEmpty();
  });
});
