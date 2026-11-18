import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { ReadinessRegistry } from '@/core/health/readiness.registry';

/** The private temporary area for inputs and results (spec 2.0 §1.3.4). */
@Injectable()
export class TempArea implements OnModuleInit {
  readonly root: string;

  constructor(
    config: ConfigService,
    private readonly readiness: ReadinessRegistry,
  ) {
    this.root = config.get('TRANSFORMATION_TEMP_DIR');
  }

  onModuleInit(): Promise<void> {
    void this.readiness;
    throw new Error('not implemented');
  }

  /** A new path with a server-generated random name; never derived from the upload's name. */
  path(): string {
    throw new Error('not implemented');
  }

  remove(path: string): Promise<void> {
    void path;
    throw new Error('not implemented');
  }
}
