import type { FastifyRequest } from 'fastify';

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

/** Reads one `file` part into the temporary area with its limit, plus the allowed text fields. */
export function readUpload(
  request: FastifyRequest,
  temp: TempArea,
  rules: UploadRules,
): Promise<Upload> {
  void [request, temp, rules];
  throw new Error('not implemented');
}
