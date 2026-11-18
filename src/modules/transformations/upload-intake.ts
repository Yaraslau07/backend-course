import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyRequest } from 'fastify';

import { AppException } from '@/core/errors/app.exception';

import type { TempArea } from './temp-area';

export interface UploadedFile {
  path: string;
  size: number;
  /** The lowercase extension of the uploaded name, or '' (the name itself is never kept). */
  extension: string;
  mime: string;
}

export interface Upload {
  file: UploadedFile;
  fields: Record<string, string>;
}

export interface UploadRules {
  /** Allowed text fields besides `file`; anything else is 400. */
  fields: readonly string[];
  /** The largest input any format of this operation accepts (the parser's hard limit). */
  maxFileBytes: number;
  /** The input limit for this extension and MIME type, or null when unsupported (415). */
  limitFor(extension: string, mime: string): number | null;
}

const FIELD_BYTES = 1024;

/** The original name only yields an extension; it is never a path and never logged (spec 2.0 §1.3.4). */
export function extensionOf(filename: string | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  return match ? match[1].toLowerCase() : '';
}

/** Copies the file part into the temporary area, refusing it the moment it passes `limit`. */
async function save(
  source: NodeJS.ReadableStream,
  path: string,
  limit: number,
): Promise<number> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > limit) done(new AppException('payload_too_large'));
      else done(null, chunk);
    },
  });
  await pipeline(
    source,
    counter,
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  return size;
}

function mapped(error: unknown): AppException {
  if (error instanceof AppException) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  return new AppException(
    code === 'FST_REQ_FILE_TOO_LARGE' ? 'payload_too_large' : 'bad_request',
  );
}

/**
 * Spec 2.0 §1.3.2 step 4: exactly one non-empty `file` part and only the allowed text fields, each
 * at most once. The file goes straight to the temporary area with the limit of its format: an
 * unsupported extension is 415, too many bytes 413, anything malformed 400. On a refusal nothing
 * is left behind.
 */
export async function readUpload(
  request: FastifyRequest,
  temp: TempArea,
  rules: UploadRules,
): Promise<Upload> {
  if (!request.isMultipart()) throw new AppException('unsupported_media_type');
  const fields: Record<string, string> = {};
  let file: UploadedFile | undefined;
  let pending: string | undefined;
  try {
    const parts = request.parts({
      limits: {
        files: 1,
        fields: rules.fields.length,
        parts: rules.fields.length + 1,
        fileSize: rules.maxFileBytes,
        fieldSize: FIELD_BYTES,
        fieldNameSize: 64,
        headerPairs: 20,
      },
    });
    for await (const part of parts) {
      if (part.type === 'field') {
        if (
          !rules.fields.includes(part.fieldname) ||
          Object.hasOwn(fields, part.fieldname) ||
          typeof part.value !== 'string' ||
          part.valueTruncated
        )
          throw new AppException('bad_request');
        fields[part.fieldname] = part.value;
        continue;
      }
      if (part.fieldname !== 'file' || file)
        throw new AppException('bad_request');
      const extension = extensionOf(part.filename);
      const limit = rules.limitFor(extension, part.mimetype);
      if (limit === null) throw new AppException('unsupported_media_type');
      pending = temp.path();
      const size = await save(part.file, pending, limit);
      if (part.file.truncated) throw new AppException('payload_too_large');
      if (size === 0) throw new AppException('bad_request');
      file = { path: pending, size, extension, mime: part.mimetype };
      pending = undefined;
    }
  } catch (error) {
    for (const path of [pending, file?.path])
      if (path) await temp.remove(path).catch(() => undefined);
    throw mapped(error);
  }
  if (!file) throw new AppException('bad_request');
  return { file, fields };
}
