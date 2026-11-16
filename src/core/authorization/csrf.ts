/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

export type CsrfRejection =
  | 'origin_not_allowed'
  | 'header_missing'
  | 'origin_missing';

export interface CsrfSettings {
  selfOrigin: string;
  allowedOrigins: ReadonlySet<string>;
}

export interface CsrfRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export function csrfSettingsFrom(_config: {
  PUBLIC_API_BASE_URL: string;
  CORS_ORIGINS: string[];
}): CsrfSettings {
  throw new Error('not implemented');
}

export function checkCsrf(
  _request: CsrfRequest,
  _settings: CsrfSettings,
): CsrfRejection | null {
  throw new Error('not implemented');
}

@Injectable()
export class CsrfPolicy {
  constructor(_config: ConfigService) {}

  assert(_request: CsrfRequest, _handler: string): void {
    throw new Error('not implemented');
  }
}
