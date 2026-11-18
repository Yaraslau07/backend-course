import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import transform, { type TransformTask } from './transform.worker';

const MODULE = join(__dirname, '../../../../test/utils/probe-converter.ts');
let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c15-worker-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function task(
  params: Record<string, unknown>,
  content = 'abc',
  outputLimit = 100,
): Promise<TransformTask> {
  n++;
  const inputPath = join(dir, `in-${n}`);
  await writeFile(inputPath, content);
  return {
    module: MODULE,
    inputPath,
    outputPath: join(dir, `out-${n}`),
    params,
    outputLimit,
  };
}

describe('transform() worker task (spec 2.0 §1.3.1)', () => {
  it('runs the converter on the streams and reports the real size', async () => {
    const t = await task({}, 'hello');
    expect(await transform(t)).toEqual({
      ok: true,
      contentType: 'text/plain; charset=utf-8',
      extension: 'upper',
      size: 5,
    });
    expect(await readFile(t.outputPath, 'utf8')).toBe('HELLO');
  });

  it('passes a converter refusal on and leaves no output', async () => {
    const t = await task({ mode: 'fail' });
    expect(await transform(t)).toEqual({ ok: false, code: 'invalid_input' });
    await expect(stat(t.outputPath)).rejects.toThrow();
  });

  it('turns a thrown error or an unknown code into converter_failed, without the message', async () => {
    for (const mode of ['throw', 'bad_code']) {
      const t = await task({ mode });
      expect(await transform(t)).toEqual({
        ok: false,
        code: 'converter_failed',
      });
      await expect(stat(t.outputPath)).rejects.toThrow();
    }
  });

  it('stops a result over the limit with result_too_large; exactly the limit passes', async () => {
    const over = await task({ mode: 'big', size: 101 });
    expect(await transform(over)).toEqual({
      ok: false,
      code: 'result_too_large',
    });
    await expect(stat(over.outputPath)).rejects.toThrow();
    const exact = await task({ mode: 'big', size: 100 });
    expect(await transform(exact)).toMatchObject({ ok: true, size: 100 });
  });

  it('ends an output the converter left open', async () => {
    const t = await task({ mode: 'no_end' }, 'xyz');
    expect(await transform(t)).toMatchObject({ ok: true, size: 3 });
    expect(await readFile(t.outputPath, 'utf8')).toBe('XYZ');
  });

  it('refuses to overwrite an existing output path', async () => {
    const t = await task({});
    await writeFile(t.outputPath, 'taken');
    expect(await transform(t)).toEqual({ ok: false, code: 'converter_failed' });
    expect(await readFile(t.outputPath, 'utf8')).toBe('taken');
  });

  it('reports a missing input or module as converter_failed', async () => {
    const t = await task({});
    expect(await transform({ ...t, inputPath: join(dir, 'nope') })).toEqual({
      ok: false,
      code: 'converter_failed',
    });
    expect(
      await transform({ ...(await task({})), module: join(dir, 'missing.js') }),
    ).toEqual({ ok: false, code: 'converter_failed' });
  });

  it('refuses an invalid content type or extension from a converter', async () => {
    const bad = join(dir, 'bad-converter.js');
    await writeFile(
      bad,
      `exports.converter = { async convert(i, p, o) { o.end('x'); return { ok: true, contentType: 'text/plain\\r\\nX: y', extension: '../x' }; } };`,
    );
    expect(await transform({ ...(await task({})), module: bad })).toEqual({
      ok: false,
      code: 'converter_failed',
    });
  });
});
