import 'reflect-metadata';

import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import {
  buildDataSourceOptions,
  databaseSettingsFromEnv,
} from './typeorm.options';

/**
 * Standalone DataSource for the TypeORM CLI (migration:generate, migration:run, …).
 * The Nest runtime builds its own from `DatabaseModule` using the same `buildDataSourceOptions()`.
 */
loadEnv({
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
  quiet: true,
});

// Exactly one export: the TypeORM CLI refuses a file exporting more than one DataSource.
export default new DataSource(
  buildDataSourceOptions(databaseSettingsFromEnv(process.env)),
);
