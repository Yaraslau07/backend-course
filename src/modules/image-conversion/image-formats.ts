// Loaded inside converter worker threads: relative imports and libraries only (D67).
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sharp from 'sharp';

export const IMAGE_SOURCES = ['png', 'jpeg', 'svg'] as const;
export const IMAGE_TARGETS = ['png', 'jpeg'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export type ImageTarget = (typeof IMAGE_TARGETS)[number];

/** Spec 2.2 §1.1: the result's largest side and pixel count. */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 16_777_216;
export const DEFAULT_QUALITY = 85;
export const DEFAULT_BACKGROUND = '#ffffff';
/** Spec 2.2 §1.3.2: an SVG with no intrinsic size renders at 1024×1024. */
export const DEFAULT_SVG_SIDE = 1024;

/** Verified options (spec 2.2 §1.3.2); the endpoint only passes the ones that apply. */
export interface ImageOptions {
  quality?: number;
  width?: number;
  height?: number;
  background?: string;
}

export type ImageErrorCode =
  | 'invalid_input'
  | 'unsafe_input'
  | 'content_mismatch'
  | 'result_too_large'
  | 'timeout';

export class ImageConversionError extends Error {
  constructor(readonly code: ImageErrorCode) {
    super(code);
  }
}

export interface ConvertedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

const fail = (code: ImageErrorCode): never => {
  throw new ImageConversionError(code);
};

export const isDirection = (source: unknown, target: unknown): boolean =>
  (source === 'png' && target === 'jpeg') ||
  (source === 'jpeg' && target === 'png') ||
  (source === 'svg' && (target === 'png' || target === 'jpeg'));

/* ---------- size limits ---------- */

function checkResult(width: number, height: number): void {
  if (
    !(width >= 1 && height >= 1) ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS
  )
    fail('result_too_large');
}

/* ---------- encoding (shared by every direction) ---------- */

/**
 * The one encoder: a JPEG mixes alpha with the background and uses the quality; a PNG keeps
 * transparency. sharp writes no metadata unless asked, so EXIF, XMP and comments never survive
 * (spec 2.2 §1.6: "re-encoded without the original metadata").
 */
async function encode(
  image: sharp.Sharp,
  target: ImageTarget,
  options: ImageOptions,
  timeoutSeconds: number,
): Promise<ConvertedImage> {
  const encoded =
    target === 'jpeg'
      ? image
          .flatten({ background: options.background ?? DEFAULT_BACKGROUND })
          .jpeg({ quality: options.quality ?? DEFAULT_QUALITY })
      : image.png();
  try {
    const { data, info } = await encoded
      .timeout({ seconds: timeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message))
      return fail('timeout');
    return fail('invalid_input');
  }
}

/* ---------- PNG and JPEG ---------- */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sniff(bytes: Buffer): 'png' | 'jpeg' | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  return null;
}

/** APNG keeps its animation in an `acTL` chunk before the image data (D73: refused). */
function isAnimatedPng(bytes: Buffer): boolean {
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
}

async function convertRaster(
  source: 'png' | 'jpeg',
  target: ImageTarget,
  bytes: Buffer,
  options: ImageOptions,
  timeoutSeconds: number,
): Promise<ConvertedImage> {
  if (sniff(bytes) !== source) fail('content_mismatch');
  if (source === 'png' && isAnimatedPng(bytes)) fail('unsafe_input');
  // The header alone gives the size, so an oversized image is refused before it is decoded.
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    return fail('invalid_input');
  }
  if (metadata.format !== source || !metadata.width || !metadata.height)
    fail('invalid_input');
  if ((metadata.pages ?? 1) > 1) fail('unsafe_input');
  const turned = (metadata.orientation ?? 1) >= 5;
  checkResult(
    turned ? metadata.height : metadata.width,
    turned ? metadata.width : metadata.height,
  );
  // `rotate()` applies the EXIF orientation before the metadata is dropped (D73).
  const image = sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'warning',
  }).rotate();
  return encode(image, target, options, timeoutSeconds);
}

/* ---------- SVG ---------- */

/** Elements that run code, embed other documents or reach out (spec 2.2 §1.3.3). */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'canvas',
  'handler',
  'listener',
]);
/** Attributes that point at a resource: only a same-document `#id` is allowed. */
const REFERENCE_ATTRIBUTES = new Set(['href', 'src']);

const tree = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Node = Record<string, unknown>;

/** `@import`, or a `url()` that isn't `#id`, would load something external. */
function externalCss(value: string): boolean {
  if (/@import/i.test(value)) return true;
  for (const match of value.matchAll(/url\(\s*(['"]?)\s*([^'")\s]*)/gi))
    if (!match[2].startsWith('#')) return true;
  return false;
}

const localName = (name: string) => name.split(':').pop()!.toLowerCase();
const elementName = (node: Node) =>
  Object.keys(node).find((key) => key !== ':@' && key !== '#text');
const textOf = (children: Node[]) =>
  children
    .map((child) => (typeof child['#text'] === 'string' ? child['#text'] : ''))
    .join('');

function checkNode(node: Node): void {
  const name = elementName(node);
  if (name === undefined) return;
  const local = localName(name);
  if (FORBIDDEN_ELEMENTS.has(local)) fail('unsafe_input');
  const attributes = (node[':@'] ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(attributes)) {
    const attribute = localName(key);
    const text = typeof value === 'string' ? value : '';
    if (attribute.startsWith('on')) fail('unsafe_input');
    if (REFERENCE_ATTRIBUTES.has(attribute) && !text.trim().startsWith('#'))
      fail('unsafe_input');
    if (externalCss(text)) fail('unsafe_input');
  }
  const children = (node[name] ?? []) as Node[];
  if (local === 'style' && externalCss(textOf(children))) fail('unsafe_input');
  for (const child of children) checkNode(child);
}

const ABSOLUTE_LENGTH = /^\s*\d*\.?\d+(e[+-]?\d+)?\s*(px|pt|pc|mm|cm|in)?\s*$/i;

/** Spec 2.2 §1.3.2: width and height, or a viewBox, give the intrinsic size. */
function hasIntrinsicSize(attributes: Record<string, unknown>): boolean {
  const width = attributes.width;
  const height = attributes.height;
  if (
    typeof width === 'string' &&
    typeof height === 'string' &&
    ABSOLUTE_LENGTH.test(width) &&
    ABSOLUTE_LENGTH.test(height)
  )
    return true;
  const box =
    typeof attributes.viewBox === 'string'
      ? attributes.viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
  return (
    box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
  );
}

/**
 * Spec 2.2 §1.3.3: parsed without a DTD (refused before parsing, as for XML in D71), without
 * scripts, foreignObject, event handlers or external references. resvg itself never uses the
 * network; references are refused here so it never reads a local file either.
 */
function checkSvg(bytes: Buffer): { text: string; intrinsic: boolean } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid_input');
  }
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) fail('unsafe_input');
  if (XMLValidator.validate(text) !== true) fail('invalid_input');
  const nodes = (tree.parse(text) as Node[]).filter((node) =>
    elementName(node),
  );
  if (nodes.length !== 1) fail('invalid_input');
  const [root] = nodes;
  if (localName(elementName(root)!) !== 'svg') fail('content_mismatch');
  checkNode(root);
  return {
    text,
    intrinsic: hasIntrinsicSize((root[':@'] ?? {}) as Record<string, unknown>),
  };
}

/** Without an intrinsic size the document is nested in a 1024×1024 viewport (D73). */
function withDefaultViewport(text: string): string {
  const body = text.replace(/^\uFEFF?\s*<\?xml[^>]*\?>/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DEFAULT_SVG_SIDE}" height="${DEFAULT_SVG_SIDE}">${body}</svg>`;
}

const RESVG_BASE: ResvgRenderOptions = { logLevel: 'off' };

/**
 * `fonts: false` skips scanning the system font database: the size pass only reads the document's
 * own width, height and viewBox, so text never changes it (D80).
 */
function load(
  text: string,
  fitTo?: ResvgRenderOptions['fitTo'],
  fonts = true,
): Resvg {
  try {
    return new Resvg(text, {
      ...RESVG_BASE,
      font: { loadSystemFonts: fonts },
      ...(fitTo ? { fitTo } : {}),
    });
  } catch {
    return fail('invalid_input');
  }
}

/**
 * Spec 2.2 §1.3.2: no dimensions → the intrinsic size; one → the other follows the aspect ratio;
 * both → exactly that size (D73). The size is checked before anything is rasterised. With both,
 * the drawing is rendered to fit inside and stretched by sharp, so no intermediate exceeds it.
 */
async function convertSvg(
  target: ImageTarget,
  bytes: Buffer,
  options: ImageOptions,
  timeoutSeconds: number,
): Promise<ConvertedImage> {
  const checked = checkSvg(bytes);
  const text = checked.intrinsic
    ? checked.text
    : withDefaultViewport(checked.text);
  const natural = load(text, undefined, false);
  const w0 = natural.width;
  const h0 = natural.height;
  if (!(w0 > 0 && h0 > 0)) fail('invalid_input');

  let width: number;
  let height: number;
  let scale: number;
  if (options.width !== undefined && options.height !== undefined) {
    width = options.width;
    height = options.height;
    scale = Math.min(width / w0, height / h0);
  } else if (options.width !== undefined) {
    width = options.width;
    height = Math.max(1, Math.round((h0 * width) / w0));
    scale = width / w0;
  } else if (options.height !== undefined) {
    height = options.height;
    width = Math.max(1, Math.round((w0 * height) / h0));
    scale = height / h0;
  } else {
    width = Math.round(w0);
    height = Math.round(h0);
    scale = 1;
  }
  checkResult(width, height);
  // At least one pixel on each side, however far the requested shape is from the drawing's.
  scale = Math.max(scale, 1 / w0, 1 / h0);
  if (Math.ceil(w0 * scale) * Math.ceil(h0 * scale) > MAX_PIXELS)
    fail('result_too_large');

  let png: Buffer;
  try {
    png = load(text, { mode: 'zoom', value: scale }).render().asPng();
  } catch {
    return fail('invalid_input');
  }
  const image = sharp(png, { limitInputPixels: MAX_PIXELS }).resize(
    width,
    height,
    {
      fit: 'fill',
    },
  );
  return encode(image, target, options, timeoutSeconds);
}

/* ---------- the four directions ---------- */

/** One of the four directions (spec 2.2 §1.3.1), or an `ImageConversionError`. */
export function convertImage(
  source: ImageSource,
  target: ImageTarget,
  bytes: Buffer,
  options: ImageOptions,
  timeoutSeconds = 25,
): Promise<ConvertedImage> {
  if (!isDirection(source, target)) throw new Error('unsupported direction');
  return source === 'svg'
    ? convertSvg(target, bytes, options, timeoutSeconds)
    : convertRaster(source, target, bytes, options, timeoutSeconds);
}
