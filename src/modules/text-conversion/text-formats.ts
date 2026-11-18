// Loaded inside converter worker threads: relative imports and libraries only (D67).
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import Papa from 'papaparse';
import YAML from 'yaml';

/** Spec 2.1: the four text formats; `.yml` is an alias of `yaml`. */
export const TEXT_FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/** The converter codes a text conversion can fail with (all 400 to the client, D68). */
export type TextErrorCode =
  | 'invalid_input'
  | 'structure_mismatch'
  | 'unsafe_input';

export class TextConversionError extends Error {
  constructor(readonly code: TextErrorCode) {
    super(code);
  }
}

/** The response type of each target. */
export const TEXT_CONTENT_TYPES: Record<TextFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
};

export function isTextFormat(value: unknown): value is TextFormat {
  return (
    typeof value === 'string' &&
    (TEXT_FORMATS as readonly string[]).includes(value)
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, string>;

const fail = (code: TextErrorCode): never => {
  throw new TextConversionError(code);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/* ---------- encoding ---------- */

/** Strict UTF-8; one leading BOM is dropped (spec 2.1 §1.1). */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid_input');
  }
}

/* ---------- CSV ---------- */

/**
 * A header is required and becomes the keys; every row has exactly its fields; values stay strings
 * (spec 2.1 §1.3.2, D70). The delimiter is fixed to `,`, so nothing is guessed.
 */
function parseCsv(text: string): Row[] {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: ',',
    header: false,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) fail('invalid_input');
  const [header, ...rows] = parsed.data;
  if (
    !header ||
    header.some((name) => name === '') ||
    new Set(header).size !== header.length
  )
    fail('invalid_input');
  return rows.map((row) => {
    if (row.length !== header.length) fail('invalid_input');
    return Object.fromEntries(header.map((name, i) => [name, row[i]]));
  });
}

/** An array of flat objects with the same keys; columns follow the first object (spec 2.1 §1.3.2). */
function toCsv(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) fail('structure_mismatch');
  const list = value as unknown[];
  const first = list[0];
  if (!isObject(first)) return fail('structure_mismatch');
  const keys = Object.keys(first);
  if (keys.length === 0 || keys.includes('')) fail('structure_mismatch');
  const data = list.map((item) => {
    if (
      !isObject(item) ||
      Object.keys(item).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(item, key))
    )
      fail('structure_mismatch');
    return keys.map((key) => cell((item as Record<string, unknown>)[key]));
  });
  return `${Papa.unparse({ fields: keys, data }, { newline: '\n' })}\n`;
}

function cell(value: unknown): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fail('structure_mismatch');
}

/* ---------- JSON and YAML ---------- */

function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return fail('invalid_input');
  }
}

/**
 * The safe loader (spec 2.1 §1.6): YAML 1.2 core schema, one document, no duplicate keys, no tags
 * outside the schema (an unresolved tag is a warning, refused here), at most 100 aliases expanded.
 */
function parseYaml(text: string): Json {
  const docs = YAML.parseAllDocuments(text, {
    schema: 'core',
    customTags: [],
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  if (!Array.isArray(docs)) return fail('invalid_input');
  if (docs.length === 0) return null;
  if (docs.length > 1) fail('invalid_input');
  const [doc] = docs;
  if (doc.errors.length > 0 || doc.warnings.length > 0) fail('invalid_input');
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    return fail('invalid_input');
  }
  return jsonValue(value);
}

/** Only what JSON can hold: YAML's `.inf` and `.nan`, for one, are not. */
function jsonValue(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : fail('structure_mismatch');
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) {
    for (const key of Object.keys(value)) jsonValue(value[key]);
    return value as Json;
  }
  return fail('structure_mismatch');
}

const toJson = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;
const toYaml = (value: Json) =>
  YAML.stringify(value, { aliasDuplicateObjects: false, lineWidth: 0 });

/* ---------- XML ---------- */

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
} as const;
const parser = new XMLParser({
  ...XML_OPTIONS,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});
const builder = new XMLBuilder({
  ...XML_OPTIONS,
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  processEntities: true,
});
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
/** Element and attribute names we write (Unicode letters allowed, D70). */
const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.:-]{0,199}$/u;

/**
 * No DTD at all (spec 2.1 §1.6): a DOCTYPE is refused before the parser sees it, because the parser
 * would expand its internal entities. Without one only the five predefined entities exist, and the
 * parser never fetches anything.
 */
function parseXml(text: string): Json {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) fail('unsafe_input');
  if (XMLValidator.validate(text) !== true) fail('invalid_input');
  const value = parser.parse(text) as Record<string, Json>;
  if (!isObject(value) || Object.keys(value).length !== 1)
    fail('invalid_input');
  return value;
}

/**
 * A single-key object is the root element (D70); `@name` keys are attributes, `#text` the text,
 * arrays repeat their element (spec 2.1 §1.3.2).
 */
function toXml(value: unknown): string {
  if (!isObject(value) || Object.keys(value).length !== 1)
    return fail('structure_mismatch');
  const [root] = Object.keys(value);
  if (!XML_NAME.test(root)) fail('structure_mismatch');
  checkElement(value[root]);
  return `${DECLARATION}${builder.build(value)}`;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function checkElement(value: unknown, inArray = false): void {
  if (isScalar(value)) return;
  if (Array.isArray(value)) {
    if (inArray) fail('structure_mismatch');
    for (const item of value) checkElement(item, true);
    return;
  }
  if (!isObject(value)) return fail('structure_mismatch');
  for (const [key, child] of Object.entries(value)) {
    if (key === '#text' || key.startsWith('@')) {
      if (!isScalar(child)) fail('structure_mismatch');
      if (key !== '#text' && !XML_NAME.test(key.slice(1)))
        fail('structure_mismatch');
      continue;
    }
    if (!XML_NAME.test(key)) fail('structure_mismatch');
    checkElement(child);
  }
}

/** CSV ↔ XML uses `<rows><row><field>…` (spec 2.1 §1.3.2). */
const rowsToXml = (rows: Row[]) =>
  toXml({ rows: rows.length > 0 ? { row: rows } : '' });

/** Only `<rows>` of `<row>`s with flat text fields converts to CSV (D70). */
function xmlRowsToCsv(value: Json): string {
  if (!isObject(value) || !Object.hasOwn(value, 'rows'))
    return fail('structure_mismatch');
  const rows = value.rows;
  if (!isObject(rows) || Object.keys(rows).join() !== 'row')
    return fail('structure_mismatch');
  const list: unknown[] = Array.isArray(rows.row) ? rows.row : [rows.row];
  for (const row of list) {
    if (!isObject(row)) return fail('structure_mismatch');
    for (const [key, field] of Object.entries(row))
      if (key === '#text' || key.startsWith('@') || typeof field !== 'string')
        fail('structure_mismatch');
  }
  return toCsv(list);
}

/* ---------- the twelve directions ---------- */

function parse(format: TextFormat, text: string): Json | Row[] {
  switch (format) {
    case 'csv':
      return parseCsv(text);
    case 'json':
      return parseJson(text);
    case 'yaml':
      return parseYaml(text);
    case 'xml':
      return parseXml(text);
  }
}

/** One of the twelve directions (spec 2.1 §1.3.2), or a `TextConversionError`. */
export function convertText(
  source: TextFormat,
  target: TextFormat,
  text: string,
): string {
  if (!isTextFormat(source) || !isTextFormat(target) || source === target)
    throw new Error('unsupported direction');
  try {
    const value = parse(source, text);
    switch (target) {
      case 'json':
        return toJson(value as Json);
      case 'yaml':
        return toYaml(value as Json);
      case 'csv':
        return source === 'xml' ? xmlRowsToCsv(value as Json) : toCsv(value);
      case 'xml':
        return source === 'csv' ? rowsToXml(value as Row[]) : toXml(value);
    }
  } catch (error) {
    if (error instanceof TextConversionError) throw error;
    // Nesting deep enough to exhaust the stack is input we refuse, not a server fault.
    if (error instanceof RangeError)
      throw new TextConversionError('invalid_input');
    throw error;
  }
}
