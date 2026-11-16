import { applyDecorators } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';

import { ACCESS_COOKIE } from '@/core/app/configure-app';
import { RBAC_NAME_PATTERN } from '@/modules/rbac/rbac.types';

/**
 * How a route may be reached (spec 1.3 §1.3.2). Every route declares exactly one of:
 * - `@Public()`: no session, no RBAC (registration, login, refresh, logout, liveness);
 * - `@Internal()`: infrastructure only, gated by the handler itself (readiness);
 * - `@RequirePermission(permission, action)`: the full authorization chain;
 * - `@Receipt(header)`, optionally with one `@RequirePermission`: if the header is present the
 *   handler checks the receipt and access/RBAC don't run; if not, the pair's chain applies.
 * Anything else (nothing, two of them, a bad name) is invalid: readiness fails and the route
 * answers 503 without running.
 */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'internal' }
  | { kind: 'protected'; permission: string; action: string }
  | {
      kind: 'receipt';
      header: string;
      pair?: { permission: string; action: string };
    }
  | { kind: 'invalid'; reason: 'missing' | 'conflict' | 'invalid_name' };

type Declaration =
  | { kind: 'public' }
  | { kind: 'internal' }
  | { kind: 'permission'; permission: string; action: string }
  | { kind: 'receipt'; header: string };

export const ROUTE_ACCESS_METADATA = 'route-access:declarations';

const RBAC_NAME = new RegExp(RBAC_NAME_PATTERN);
/** An HTTP header name we accept for a receipt: letters, digits and hyphens. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Appends rather than overwrites, so two declarations on one handler are both visible
 * and the route resolves to `conflict` instead of silently keeping the last one.
 */
function declare(declaration: Declaration): MethodDecorator {
  return (_target, _key, descriptor) => {
    const handler = descriptor.value as object;
    const existing = (Reflect.getMetadata(ROUTE_ACCESS_METADATA, handler) ??
      []) as Declaration[];
    Reflect.defineMetadata(
      ROUTE_ACCESS_METADATA,
      [...existing, declaration],
      handler,
    );
  };
}

export const Public = (): MethodDecorator => declare({ kind: 'public' });

export const Internal = (): MethodDecorator => declare({ kind: 'internal' });

/** OpenAPI marks the route with the cookie scheme; the server never trusts the document. */
export const RequirePermission = (
  permission: string,
  action: string,
): MethodDecorator =>
  applyDecorators(
    declare({ kind: 'permission', permission, action }),
    ApiCookieAuth(ACCESS_COOKIE),
  );

export const Receipt = (header: string): MethodDecorator =>
  declare({ kind: 'receipt', header });

function isDeclaration(value: unknown): value is Declaration {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'public' ||
    kind === 'internal' ||
    kind === 'permission' ||
    kind === 'receipt'
  );
}

/** Same normalization as RBAC names (spec 1.1): trim, lowercase, then the pattern. */
function normalizePair(
  declaration: Extract<Declaration, { kind: 'permission' }>,
): { permission: string; action: string } | null {
  const permission = declaration.permission.trim().toLowerCase();
  const action = declaration.action.trim().toLowerCase();
  return RBAC_NAME.test(permission) && RBAC_NAME.test(action)
    ? { permission, action }
    : null;
}

export function resolveRouteAccess(declarations: unknown): RouteAccess {
  if (declarations === undefined) return { kind: 'invalid', reason: 'missing' };
  if (!Array.isArray(declarations) || !declarations.every(isDeclaration)) {
    return { kind: 'invalid', reason: 'conflict' };
  }
  if (declarations.length === 0) return { kind: 'invalid', reason: 'missing' };

  const count = (kind: Declaration['kind']) =>
    declarations.filter((d) => d.kind === kind).length;
  const pairs = declarations.filter((d) => d.kind === 'permission');
  const receipts = declarations.filter((d) => d.kind === 'receipt');

  if (declarations.length === 1 && count('public') === 1) {
    return { kind: 'public' };
  }
  if (declarations.length === 1 && count('internal') === 1) {
    return { kind: 'internal' };
  }
  // From here on only pairs and receipts are allowed: at most one of each.
  if (
    count('public') > 0 ||
    count('internal') > 0 ||
    pairs.length > 1 ||
    receipts.length > 1
  ) {
    return { kind: 'invalid', reason: 'conflict' };
  }

  const pair = pairs.length === 1 ? normalizePair(pairs[0]) : undefined;
  if (pair === null) return { kind: 'invalid', reason: 'invalid_name' };

  if (receipts.length === 1) {
    const header = receipts[0].header;
    if (!HEADER_NAME.test(header)) {
      return { kind: 'invalid', reason: 'invalid_name' };
    }
    return pair
      ? { kind: 'receipt', header: header.toLowerCase(), pair }
      : { kind: 'receipt', header: header.toLowerCase() };
  }
  // Exactly one pair and nothing else.
  return { kind: 'protected', ...pair! };
}

const cache = new WeakMap<object, RouteAccess>();

/** The resolved declaration of a route handler, computed once per handler. */
export function getRouteAccess(handler: object): RouteAccess {
  let access = cache.get(handler);
  if (!access) {
    access = resolveRouteAccess(
      Reflect.getMetadata(ROUTE_ACCESS_METADATA, handler),
    );
    cache.set(handler, access);
  }
  return access;
}
