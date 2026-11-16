import {
  Injectable,
  Logger,
  type OnModuleInit,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService } from '@nestjs/core';

import { ReadinessRegistry } from '@/core/health/readiness.registry';

import { getRouteAccess, type RouteAccess } from './route-access';

export interface ScannedRoute {
  /** For example `GET /users/:userId`. */
  route: string;
  /** For example `UsersController.get`. */
  handler: string;
  access: RouteAccess;
}

/** First entry of a Nest path, which may be a string or an array of aliases. */
function firstPath(value: unknown): string {
  const path = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof path === 'string' ? path : '';
}

/** Method names on the prototype chain, own ones first, including handlers of a base controller. */
function handlerNames(prototype: object): string[] {
  const names = new Set<string>();
  for (
    let level: object | null = prototype;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name !== 'constructor') names.add(name);
    }
  }
  return [...names];
}

function joinPath(...parts: string[]): string {
  const segments = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return `/${segments.join('/')}`;
}

/**
 * At startup, checks every route handler's access declaration (spec 1.3 §1.3.2). Invalid ones
 * are logged and keep readiness down, so a misdeclared route never takes traffic in a healthy
 * deployment. The guard independently refuses such a route if a request reaches it anyway.
 */
@Injectable()
export class RouteDeclarationScanner implements OnModuleInit {
  private readonly logger = new Logger('Authorization');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    const invalid = this.scan().filter(
      (route) => route.access.kind === 'invalid',
    );
    for (const { route, handler, access } of invalid) {
      this.logger.error(
        {
          category: 'route_configuration',
          route,
          handler,
          reason: access.kind === 'invalid' ? access.reason : undefined,
        },
        'route has no valid access declaration',
      );
    }
    this.registry.register('route_declarations', () =>
      Promise.resolve(
        invalid.length === 0
          ? 'up'
          : { down: `${invalid.length}_invalid_routes` },
      ),
    );
  }

  scan(): ScannedRoute[] {
    const routes: ScannedRoute[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype as
        | (new (...args: never[]) => unknown)
        | null;
      if (!controller) continue;
      const basePath = firstPath(
        Reflect.getMetadata(PATH_METADATA, controller),
      );
      const prototype = controller.prototype as Record<string, unknown>;

      for (const name of handlerNames(prototype)) {
        const handler = prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
        // Only route handlers carry both; helpers and lifecycle methods don't.
        if (method === undefined || path === undefined) continue;

        routes.push({
          route: `${RequestMethod[method]} ${joinPath(basePath, firstPath(path))}`,
          handler: `${controller.name}.${name}`,
          access: getRouteAccess(handler),
        });
      }
    }
    return routes;
  }
}
