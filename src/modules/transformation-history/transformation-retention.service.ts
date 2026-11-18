import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

/** Spec 2.3 §1.3.5, §1.6: deletes history older than the retention period, in small batches. */
@Injectable()
export class TransformationRetention implements OnModuleInit, OnModuleDestroy {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    throw new Error('not implemented');
  }

  onModuleDestroy(): void {
    throw new Error('not implemented');
  }

  /** One sweep; returns how many rows it deleted. */
  run(): Promise<number> {
    void [this.db, this.config];
    throw new Error('not implemented');
  }
}
