import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Counters live in the shared app_test database and outlive a test run, so a suite that hits
 * rate-limited routes clears them first. Call it in `beforeAll` (and wherever a test needs a fresh window).
 */
export async function resetRateLimits(app: INestApplication): Promise<void> {
  await app.get(DataSource).query('DELETE FROM rate_limits');
}
