import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../../src/database/typeorm.options';

/**
 * A plain DataSource on the test database (variables come from .env.test via setup-env.ts, or from CI).
 * Relative imports only: Jest's globalSetup doesn't apply `moduleNameMapper`, and it uses this file too.
 */
export function createTestDataSource(): DataSource {
  return new DataSource(
    buildDataSourceOptions({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      username: process.env.POSTGRES_USER ?? '',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.POSTGRES_DB ?? '',
      logging: false,
      migrationsRun: false,
    }),
  );
}
