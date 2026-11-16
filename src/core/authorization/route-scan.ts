import type { OnModuleInit } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';

import type { ReadinessRegistry } from '@/core/health/readiness.registry';

import type { RouteAccess } from './route-access';

export interface ScannedRoute {
  route: string;
  handler: string;
  access: RouteAccess;
}

export class RouteDeclarationScanner implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    throw new Error('not implemented');
  }

  scan(): ScannedRoute[] {
    throw new Error('not implemented');
  }
}
