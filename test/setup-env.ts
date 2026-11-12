import { config as loadEnv } from 'dotenv';

// e2e tests run against .env.test (test-only keys, the app_test database).
// Variables already in the environment (CI) win over the file.
process.env.NODE_ENV = 'test';
loadEnv({ path: '.env.test', quiet: true });
