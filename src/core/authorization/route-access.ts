/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
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

export const ROUTE_ACCESS_METADATA = 'route-access:declarations';

const noop: MethodDecorator = () => undefined;
export const Public = (): MethodDecorator => noop;
export const Internal = (): MethodDecorator => noop;
export const RequirePermission = (
  _permission: string,
  _action: string,
): MethodDecorator => noop;
export const Receipt = (_header: string): MethodDecorator => noop;

export function resolveRouteAccess(_declarations: unknown): RouteAccess {
  throw new Error('not implemented');
}

export function getRouteAccess(_handler: object): RouteAccess {
  throw new Error('not implemented');
}
