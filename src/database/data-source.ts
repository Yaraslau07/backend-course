import 'reflect-metadata';

import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from './typeorm.options';

/**
 * Standalone DataSource for the TypeORM CLI (migration:generate, migration:run, …).
 * The Nest runtime builds its own from `DatabaseModule` using the same `buildDataSourceOptions()`.
 * Only the DB variables are needed here, so the CLI doesn't require the app's secrets.
 */
loadEnv({
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
  quiet: true,
});

// Exactly one export: the TypeORM CLI refuses a file exporting more than one DataSource.
export default new DataSource(
  buildDataSourceOptions({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER ?? '',
    password: process.env.POSTGRES_PASSWORD ?? '',
    database: process.env.POSTGRES_DB ?? '',
    logging: process.env.POSTGRES_LOGGING === 'true',
    migrationsRun: false,
  }),
);
