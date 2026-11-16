/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
import type { RateLimitName } from './rate-limit.policies';

export const RateLimit =
  (..._names: RateLimitName[]): MethodDecorator =>
  () =>
    undefined;

export function getRouteRateLimits(_handler: object): {
  ip: RateLimitName[];
  user: RateLimitName[];
} {
  throw new Error('not implemented');
}
