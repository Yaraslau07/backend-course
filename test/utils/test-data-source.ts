import { DataSource } from 'typeorm';

import {
  buildDataSourceOptions,
  databaseSettingsFromEnv,
} from '../../src/database/typeorm.options';

/**
 * A plain DataSource on the test database (variables come from .env.test via setup-env.ts, or from CI).
 * Relative imports only: Jest's globalSetup doesn't apply `moduleNameMapper`, and it uses this file too.
 */
export function createTestDataSource(): DataSource {
  const settings = databaseSettingsFromEnv(process.env);
  // Variables already exported in the shell win over .env.test, so a stray POSTGRES_DB=app would
  // point the suite (and its migrations) at a real database. Refuse anything not named like a test DB.
  if (!settings.database.endsWith('_test')) {
    throw new Error(
      `Refusing to run e2e tests against "${settings.database}": POSTGRES_DB must end with "_test"`,
    );
  }
  return new DataSource(
    buildDataSourceOptions({ ...settings, logging: false }),
  );
}
