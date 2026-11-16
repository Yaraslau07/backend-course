import './setup-env';

import { createTestDataSource } from './utils/test-data-source';

/**
 * Brings the test database up to date once, before any e2e suite, so `npm run test:e2e`
 * works on a fresh clone without a separate `migration:run`. Already-applied migrations are skipped.
 */
export default async function globalSetup(): Promise<void> {
  const dataSource = createTestDataSource();
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
