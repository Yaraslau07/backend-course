import { Readable, Writable } from 'node:stream';

import { converter } from './text.converter';

function sink() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('text converter (worker side)', () => {
  it('converts the whole input and reports the target type and extension', async () => {
    const out = sink();
    expect(
      await converter.convert(
        Readable.from([Buffer.from('\uFEFFa,b\n'), Buffer.from('1,2\n')]),
        { source: 'csv', target: 'json' },
        out.stream,
      ),
    ).toEqual({
      ok: true,
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
    });
    expect(JSON.parse(out.text())).toEqual([{ a: '1', b: '2' }]);
    expect(out.stream.writableEnded).toBe(true);
  });

  it('returns the format error code and writes nothing', async () => {
    const out = sink();
    expect(
      await converter.convert(
        Readable.from([Buffer.from('<!DOCTYPE a []><a/>')]),
        { source: 'xml', target: 'json' },
        out.stream,
      ),
    ).toEqual({ ok: false, code: 'unsafe_input' });
    expect(out.text()).toBe('');
  });

  it('refuses parameters that are not a known direction', async () => {
    await expect(
      converter.convert(
        Readable.from([Buffer.from('a')]),
        { source: 'csv', target: 'toml' },
        sink().stream,
      ),
    ).rejects.toThrow();
  });
});
