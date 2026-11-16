import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { AppException } from '@/core/errors/app.exception';

export type CsrfRejection =
  | 'origin_not_allowed'
  | 'header_missing'
  | 'origin_missing';

export interface CsrfSettings {
  /** The API's own origin, from PUBLIC_API_BASE_URL. Requests from it are same-origin. */
  selfOrigin: string;
  /** CORS_ORIGINS: the only other origins allowed to write, with the header. */
  allowedOrigins: ReadonlySet<string>;
}

export interface CsrfRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Methods that never change state (spec 1.3 §1.3.5: "GET and HEAD do not change state"). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfSettingsFrom(config: {
  PUBLIC_API_BASE_URL: string;
  CORS_ORIGINS: string[];
}): CsrfSettings {
  return {
    selfOrigin: new URL(config.PUBLIC_API_BASE_URL).origin,
    allowedOrigins: new Set(config.CORS_ORIGINS),
  };
}

/** Browsers send a canonical origin; anything that isn't exactly one (a path, `null`, junk) is refused. */
function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * Specs 1.2 §1.3.3 and 1.3 §1.3.5. A write from another origin needs that exact origin in
 * CORS_ORIGINS and `X-CSRF-Protection: 1`, even when the two origins are same-site. A write
 * from the API's own origin passes. A write without `Origin` comes from a non-browser client
 * (an HTTP client, curl) and passes, unless the browser's `Sec-Fetch-Site` says it is
 * cross-site or same-site: then a browser stripped the origin, and it is refused.
 */
export function checkCsrf(
  request: CsrfRequest,
  settings: CsrfSettings,
): CsrfRejection | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.origin;
  if (origin === undefined) {
    const site = request.headers['sec-fetch-site'];
    return site === 'cross-site' || site === 'same-site'
      ? 'origin_missing'
      : null;
  }
  if (typeof origin !== 'string' || !isExactOrigin(origin)) {
    return 'origin_not_allowed';
  }
  if (origin === settings.selfOrigin) return null;
  if (!settings.allowedOrigins.has(origin)) return 'origin_not_allowed';
  return request.headers['x-csrf-protection'] === '1' ? null : 'header_missing';
}

@Injectable()
export class CsrfPolicy {
  private readonly logger = new Logger('Authorization');
  private readonly settings: CsrfSettings;

  constructor(config: ConfigService) {
    this.settings = csrfSettingsFrom({
      PUBLIC_API_BASE_URL: config.get('PUBLIC_API_BASE_URL'),
      CORS_ORIGINS: config.get('CORS_ORIGINS'),
    });
  }

  /** Throws `403 csrf_rejected` for a refused write. Logs the reason, never the origin. */
  assert(request: CsrfRequest, handler: string): void {
    const reason = checkCsrf(request, this.settings);
    if (reason === null) return;
    this.logger.warn(
      { category: 'csrf_rejected', reason, handler },
      'cross-origin write rejected',
    );
    throw new AppException('csrf_rejected');
  }
}
