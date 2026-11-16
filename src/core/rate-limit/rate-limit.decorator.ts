import { RATE_LIMIT_POLICIES, type RateLimitName } from './rate-limit.policies';

export const RATE_LIMIT_METADATA = 'rate-limit:policies';

/**
 * Applies spec rate limits to a route, checked by the route guard before the handler.
 * IP-keyed policies run on every route; user-keyed ones need a session, so they are only
 * valid on `@RequirePermission` routes (the route scan refuses them elsewhere).
 */
export const RateLimit =
  (...names: RateLimitName[]): MethodDecorator =>
  (_target, _key, descriptor) => {
    const handler = descriptor.value as object;
    const existing = (Reflect.getMetadata(RATE_LIMIT_METADATA, handler) ??
      []) as RateLimitName[];
    Reflect.defineMetadata(
      RATE_LIMIT_METADATA,
      [...existing, ...names],
      handler,
    );
  };

export function getRouteRateLimits(handler: object): {
  ip: RateLimitName[];
  user: RateLimitName[];
} {
  const names = (Reflect.getMetadata(RATE_LIMIT_METADATA, handler) ??
    []) as RateLimitName[];
  return {
    ip: names.filter((name) => RATE_LIMIT_POLICIES[name].by === 'ip'),
    user: names.filter((name) => RATE_LIMIT_POLICIES[name].by === 'user'),
  };
}
