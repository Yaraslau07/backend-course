import { XMLParser } from 'fast-xml-parser';
import Papa from 'papaparse';
import YAML from 'yaml';

import {
  convertText,
  decodeUtf8,
  TextConversionError,
  type TextFormat,
} from './text-formats';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
});

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof TextConversionError
      ? error.code
      : `other:${String(error)}`;
  }
  return 'none';
};
const convert = (source: TextFormat, target: TextFormat, text: string) =>
  convertText(source, target, text);

/** Quotes, commas, newlines and non-Latin text: what CSV libraries get wrong (spec 2.1 §1.6). */
const ROWS = [
  { name: 'Ada', city: 'Zürich, CH', note: 'line one\nline two' },
  { name: '"Bob"', city: 'Москва', note: '日本語 ✓' },
];
const CSV =
  'name,city,note\nAda,"Zürich, CH","line one\nline two"\n"""Bob""",Москва,日本語 ✓\n';

describe('decodeUtf8() (spec 2.1 §1.1)', () => {
  it('strips one leading BOM and keeps everything else', () => {
    expect(decodeUtf8(Buffer.from('\uFEFFa\uFEFF', 'utf8'))).toBe('a\uFEFF');
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(codeOf(() => decodeUtf8(Buffer.from([0x61, 0xff, 0x62])))).toBe(
      'invalid_input',
    );
  });
});

describe('CSV as the source (spec 2.1 §1.3.2)', () => {
  it('csv → json: an array of objects, values stay strings (D70)', () => {
    const out = convert('csv', 'json', 'id,code,flag\n1,007,true\n');
    expect(out).toBe(
      `${JSON.stringify([{ id: '1', code: '007', flag: 'true' }], null, 2)}\n`,
    );
    expect(JSON.parse(convert('csv', 'json', CSV))).toEqual(ROWS);
  });

  it('csv → yaml: the same objects', () => {
    expect(YAML.parse(convert('csv', 'yaml', CSV))).toEqual(ROWS);
    expect(YAML.parse(convert('csv', 'yaml', 'code\n007\n'))).toEqual([
      { code: '007' },
    ]);
  });

  it('csv → xml: rows/row/field', () => {
    const out = convert('csv', 'xml', CSV);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(xml.parse(out)).toEqual({ rows: { row: ROWS } });
    expect(xml.parse(convert('csv', 'xml', 'a,b\n1,2\n'))).toEqual({
      rows: { row: { a: '1', b: '2' } },
    });
  });

  it('a header-only CSV is an empty table', () => {
    expect(JSON.parse(convert('csv', 'json', 'a,b\n'))).toEqual([]);
    expect(xml.parse(convert('csv', 'xml', 'a,b\n'))).toEqual({ rows: '' });
  });

  it('accepts CRLF line endings', () => {
    expect(JSON.parse(convert('csv', 'json', 'a,b\r\n1,2\r\n'))).toEqual([
      { a: '1', b: '2' },
    ]);
  });

  it.each([
    ['an unterminated quote', 'a,b\n"1,2\n'],
    ['a row with too few fields', 'a,b\n1\n'],
    ['a row with too many fields', 'a,b\n1,2,3\n'],
    ['a duplicate header', 'a,a\n1,2\n'],
    ['an empty header name', 'a,\n1,2\n'],
    ['no header at all', '\n\n'],
  ])('refuses %s (invalid_input)', (_name, text) => {
    expect(codeOf(() => convert('csv', 'json', text))).toBe('invalid_input');
  });

  it('a header that is not an XML name cannot become an element (structure_mismatch)', () => {
    expect(codeOf(() => convert('csv', 'xml', 'first name\nAda\n'))).toBe(
      'structure_mismatch',
    );
    expect(xml.parse(convert('csv', 'xml', 'имя\nАда\n'))).toEqual({
      rows: { row: { имя: 'Ада' } },
    });
  });
});

describe('JSON as the source', () => {
  const typed = {
    a: 1,
    b: true,
    c: null,
    d: [1.5, 'x'],
    e: '007',
    f: { g: -2 },
  };

  it('json → yaml → json keeps types; comments and formatting are not kept', () => {
    const yaml = convert('json', 'yaml', JSON.stringify(typed));
    expect(YAML.parse(yaml)).toEqual(typed);
    expect(JSON.parse(convert('yaml', 'json', yaml))).toEqual(typed);
    expect(
      JSON.parse(convert('yaml', 'json', '# comment\na: 1 # trailing\n')),
    ).toEqual({ a: 1 });
  });

  it('json → csv: an array of flat objects with the same keys, in the first object’s order', () => {
    expect(convert('json', 'csv', JSON.stringify(ROWS))).toBe(CSV);
    expect(
      convert(
        'json',
        'csv',
        JSON.stringify([
          { a: 1, b: true, c: null },
          { c: 'x', b: false, a: 2.5 },
        ]),
      ),
    ).toBe('a,b,c\n1,true,\n2.5,false,x\n');
  });

  it.each([
    ['an object', { a: 1 }],
    ['an empty array', []],
    ['a nested value', [{ a: { b: 1 } }]],
    ['an array value', [{ a: [1] }]],
    ['different keys', [{ a: 1 }, { b: 1 }]],
    ['an extra key', [{ a: 1 }, { a: 1, b: 2 }]],
    ['a non-object row', [{ a: 1 }, 5]],
    ['an object without keys', [{}]],
    ['an empty key', [{ '': 1 }]],
  ])('json → csv refuses %s (structure_mismatch)', (_name, value) => {
    expect(codeOf(() => convert('json', 'csv', JSON.stringify(value)))).toBe(
      'structure_mismatch',
    );
  });

  it('json → xml: a single-key object is the root; @attributes, #text, arrays as repeated elements (D70)', () => {
    const value = {
      order: {
        '@id': '7',
        item: ['a', 'b'],
        note: { '@lang': 'en', '#text': 'hi & <bye>' },
        empty: null,
        count: 3,
      },
    };
    const out = convert('json', 'xml', JSON.stringify(value));
    expect(xml.parse(out)).toEqual({
      order: {
        '@id': '7',
        item: ['a', 'b'],
        note: { '@lang': 'en', '#text': 'hi & <bye>' },
        empty: '',
        count: '3',
      },
    });
    expect(out).toContain('hi &amp; &lt;bye&gt;');
  });

  it.each([
    ['an array', [{ a: 1 }]],
    ['two top-level keys', { a: 1, b: 2 }],
    ['a scalar', 5],
    ['an attribute at the top', { '@a': '1' }],
    ['an element name with a space', { 'a b': 1 }],
    ['an element name starting with a digit', { a: { '1x': 1 } }],
    ['a nested array', { a: { b: [[1]] } }],
    ['an object attribute', { a: { '@x': { y: 1 } } }],
    ['an object as #text', { a: { '#text': { y: 1 } } }],
    ['a control character XML 1.0 cannot hold', { a: 'x\u0001y' }],
    ['a NUL in an attribute', { a: { '@x': 'a\u0000b' } }],
    ['a lone surrogate', { a: 'x\ud800y' }],
  ])('json → xml refuses %s (structure_mismatch)', (_name, value) => {
    expect(codeOf(() => convert('json', 'xml', JSON.stringify(value)))).toBe(
      'structure_mismatch',
    );
  });

  it('tabs, newlines, non-BMP characters and other legal text still convert to XML', () => {
    const out = convert('json', 'xml', JSON.stringify({ a: 'tab\tnl\n😀 é' }));
    expect(out).toContain('😀');
    expect(JSON.parse(convert('xml', 'json', out)) as unknown).toEqual({
      a: 'tab\tnl\n😀 é',
    });
  });

  it('bad syntax and absurd nesting are invalid_input', () => {
    expect(codeOf(() => convert('json', 'yaml', '{"a":'))).toBe(
      'invalid_input',
    );
    expect(
      codeOf(() => convert('json', 'xml', `{"a":${'['.repeat(200_000)}`)),
    ).toBe('invalid_input');
    const deep = `{"a":${'{"b":'.repeat(20_000)}1${'}'.repeat(20_000)}}`;
    expect(['invalid_input', 'none']).toContain(
      codeOf(() => convert('json', 'xml', deep)),
    );
  });
});

describe('XML as the source (spec 2.1 §1.6: no DTD, no external entities)', () => {
  const ORDER =
    '<?xml version="1.0"?><order id="7"><item>a</item><item>b</item><note lang="en">hi</note><n>007</n></order>';

  it('xml → json/yaml: @attributes, #text, repeated elements as arrays, values as strings', () => {
    const expected = {
      order: {
        '@id': '7',
        item: ['a', 'b'],
        note: { '@lang': 'en', '#text': 'hi' },
        n: '007',
      },
    };
    expect(JSON.parse(convert('xml', 'json', ORDER))).toEqual(expected);
    expect(YAML.parse(convert('xml', 'yaml', ORDER))).toEqual(expected);
  });

  it('xml → csv: only rows/row with flat, uniform fields (D70)', () => {
    const rows =
      '<rows><row><name>Ada</name><city>Zürich, CH</city><note>line one\nline two</note></row>' +
      '<row><name>"Bob"</name><city>Москва</city><note>日本語 ✓</note></row></rows>';
    expect(convert('xml', 'csv', rows)).toBe(CSV);
    expect(convert('xml', 'csv', '<rows><row><a>1</a></row></rows>')).toBe(
      'a\n1\n',
    );
  });

  it.each([
    ['another root', '<users><row><a>1</a></row></users>'],
    ['another child', '<rows><user><a>1</a></user></rows>'],
    ['no rows', '<rows/>'],
    ['an attribute on a row', '<rows><row id="1"><a>1</a></row></rows>'],
    ['a nested field', '<rows><row><a><b>1</b></a></row></rows>'],
    ['a repeated field', '<rows><row><a>1</a><a>2</a></row></rows>'],
    ['different fields', '<rows><row><a>1</a></row><row><b>1</b></row></rows>'],
    ['text in a row', '<rows><row>x</row></rows>'],
  ])('xml → csv refuses %s (structure_mismatch)', (_name, text) => {
    expect(codeOf(() => convert('xml', 'csv', text))).toBe(
      'structure_mismatch',
    );
  });

  it('refuses any DTD before parsing: inline entities and external ones (unsafe_input)', () => {
    for (const text of [
      '<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>',
      '<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>',
      '<?xml version="1.0"?>\n<!doctype a [<!ENTITY x SYSTEM "http://evil.test/">]><a>&x;</a>',
    ]) {
      expect(codeOf(() => convert('xml', 'json', text))).toBe('unsafe_input');
    }
  });

  it.each([
    ['an unclosed tag', '<a><b>1</b>'],
    ['two roots', '<a/><b/>'],
    ['no element', 'just text'],
    ['mismatched tags', '<a></b>'],
  ])('refuses %s (invalid_input)', (_name, text) => {
    expect(codeOf(() => convert('xml', 'json', text))).toBe('invalid_input');
  });
});

describe('XML character references (D81)', () => {
  it('decodes numeric references once, in text and attributes', () => {
    const out = JSON.parse(
      convert('xml', 'json', '<a x="&#66;&#x43;">&#65;&#x42;&lt;&amp;lt;</a>'),
    ) as unknown;
    expect(out).toEqual({ a: { '@x': 'BC', '#text': 'AB<&lt;' } });
  });

  it.each([
    '&#0;',
    '&#1;',
    '&#xD800;',
    '&#x110000;',
    '&#65536000;',
    '&#xFFFE;',
  ])(
    'refuses %s, a character XML 1.0 cannot hold (invalid_input)',
    (reference) => {
      expect(
        codeOf(() => convert('xml', 'json', `<a>x${reference}y</a>`)),
      ).toBe('invalid_input');
    },
  );

  it('accepts tab, newline and non-BMP references', () => {
    expect(
      JSON.parse(
        convert('xml', 'json', '<a>x&#9;y&#xA;&#x1F600;</a>'),
      ) as unknown,
    ).toEqual({ a: 'x\ty\n😀' });
  });
});

describe('YAML as the source (spec 2.1 §1.6: safe loader)', () => {
  it('yaml → csv and yaml → xml', () => {
    expect(
      convert('yaml', 'csv', '- a: 1\n  b: x\n- a: 2\n  b: "y, z"\n'),
    ).toBe('a,b\n1,x\n2,"y, z"\n');
    expect(
      xml.parse(convert('yaml', 'xml', 'doc:\n  "@v": 2\n  p: [a, b]\n')),
    ).toEqual({
      doc: { '@v': '2', p: ['a', 'b'] },
    });
  });

  it.each([
    ['bad syntax', 'a: [1, 2\n'],
    ['several documents', 'a: 1\n---\nb: 2\n'],
    ['duplicate keys', 'a: 1\na: 2\n'],
    ['an unknown tag', 'a: !!python/object:os.system ls\n'],
    ['a custom tag', 'a: !secret x\n'],
    [
      'an alias explosion',
      `a: &a [x, x, x, x, x, x, x, x, x]\n${Array.from(
        { length: 12 },
        (_, i) =>
          `l${i + 1}: &l${i + 1} [${Array(9)
            .fill(i === 0 ? '*a' : `*l${i}`)
            .join(', ')}]`,
      ).join('\n')}\n`,
    ],
  ])('refuses %s (invalid_input)', (_name, text) => {
    expect(codeOf(() => convert('yaml', 'json', text))).toBe('invalid_input');
  });

  it('a value JSON cannot hold is structure_mismatch', () => {
    expect(codeOf(() => convert('yaml', 'json', 'a: .inf\n'))).toBe(
      'structure_mismatch',
    );
    expect(codeOf(() => convert('yaml', 'json', 'a: .nan\n'))).toBe(
      'structure_mismatch',
    );
  });

  it('an empty document is null', () => {
    expect(convert('yaml', 'json', '# nothing here\n')).toBe('null\n');
  });
});

describe('every direction', () => {
  it('refuses a direction to itself', () => {
    expect(codeOf(() => convert('csv', 'csv', 'a\n1\n'))).toBe(
      'other:Error: unsupported direction',
    );
  });

  it('a value typed by its source survives a round trip through every other format', () => {
    const table = 'a,b\nx,"1, 2"\n';
    for (const via of ['json', 'yaml', 'xml'] as TextFormat[]) {
      expect(convert(via, 'csv', convert('csv', via, table))).toBe(table);
    }
    expect(Papa.parse(table).data).toEqual([['a', 'b'], ['x', '1, 2'], ['']]);
  });
});
