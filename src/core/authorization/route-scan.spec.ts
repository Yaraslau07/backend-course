import { Controller, Get, Logger, Post } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';

import { ReadinessRegistry } from '@/core/health/readiness.registry';

import { Public, RequirePermission } from './route-access';
import { RouteDeclarationScanner } from './route-scan';

@Controller('good')
class GoodController {
  @Get()
  @Public()
  list() {}

  @Post(':id/things')
  @RequirePermission('things', 'create')
  create() {}

  /** Not a route: no HTTP method decorator, so it is not scanned. */
  helper() {}
}

@Controller('bad')
class BadController {
  @Get('missing')
  missing() {}

  @Get('conflict')
  @Public()
  @RequirePermission('things', 'read')
  conflict() {}
}

function discoveryOf(...controllers: (new () => unknown)[]): DiscoveryService {
  return {
    getControllers: () => controllers.map((metatype) => ({ metatype })),
  } as unknown as DiscoveryService;
}

describe('RouteDeclarationScanner', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('lists every route handler with its method, path and resolved access', () => {
    const scanner = new RouteDeclarationScanner(
      discoveryOf(GoodController),
      new ReadinessRegistry(),
    );

    expect(scanner.scan()).toEqual([
      {
        route: 'GET /good',
        handler: 'GoodController.list',
        access: { kind: 'public' },
      },
      {
        route: 'POST /good/:id/things',
        handler: 'GoodController.create',
        access: { kind: 'protected', permission: 'things', action: 'create' },
      },
    ]);
  });

  it('registers a readiness check that is up when every route is declared', async () => {
    const registry = new ReadinessRegistry();
    new RouteDeclarationScanner(
      discoveryOf(GoodController),
      registry,
    ).onModuleInit();

    expect(registry.names()).toContain('route_declarations');
    expect(await registry.run()).toMatchObject({
      checks: { route_declarations: 'up' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('fails readiness and logs each invalid route once at startup', async () => {
    const registry = new ReadinessRegistry();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    new RouteDeclarationScanner(
      discoveryOf(GoodController, BadController),
      registry,
    ).onModuleInit();

    expect(await registry.run()).toMatchObject({
      status: 'unavailable',
      checks: { route_declarations: 'down' },
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      {
        category: 'route_configuration',
        route: 'GET /bad/missing',
        handler: 'BadController.missing',
        reason: 'missing',
      },
      'route has no valid access declaration',
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'BadController.conflict',
        reason: 'conflict',
      }),
      'route has no valid access declaration',
    );
  });
});
