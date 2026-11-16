import type { DataSourceOptions } from 'typeorm';

export interface DatabaseSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  logging: boolean;
  migrationsRun: boolean;
}

/**
 * Connection options shared by the Nest runtime (`DatabaseModule`) and the TypeORM CLI (`data-source.ts`),
 * so the two can't drift. Globs are built from `__dirname` so they work from both `src/` (ts-node) and `dist/`.
 * Schema changes go through migrations only; `synchronize` is never enabled.
 */
export function buildDataSourceOptions(
  settings: DatabaseSettings,
): DataSourceOptions {
  // Match only this build's own extension: dist/ also contains .d.ts files that must not be loaded.
  const ext = __filename.endsWith('.ts') ? 'ts' : 'js';

  return {
    type: 'postgres',
    host: settings.host,
    port: settings.port,
    username: settings.username,
    password: settings.password,
    database: settings.database,

    entities: [`${__dirname}/../**/*.entity.${ext}`],

    migrationsTableName: 'migrations',
    // Matches the CLI's own naming (`<timestamp>-<Name>.ts`), which `migration:create`/`migration:generate` produce.
    migrations: [`${__dirname}/migrations/*-*.${ext}`],
    migrationsRun: settings.migrationsRun,

    synchronize: false,
    logging: settings.logging,
  };
}
