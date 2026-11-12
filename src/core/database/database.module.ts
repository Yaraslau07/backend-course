import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigService } from '@/core/config/config.service';
import { buildDataSourceOptions } from '@/database/typeorm.options';

/**
 * Transactions are explicit: `dataSource.transaction(async (manager) => …)`, with row locks taken
 * in the documented order (see docs/invariants.md). There is no ambient @Transactional() context.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions({
          host: config.get('POSTGRES_HOST'),
          port: config.get('POSTGRES_PORT'),
          username: config.get('POSTGRES_USER'),
          password: config.get('POSTGRES_PASSWORD'),
          database: config.get('POSTGRES_DB'),
          logging: config.get('POSTGRES_LOGGING'),
          migrationsRun: config.get('POSTGRES_MIGRATIONS_RUN'),
        }),
        autoLoadEntities: true,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
