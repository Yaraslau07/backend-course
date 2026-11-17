import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PhotoReferenceIndex1794933000000 implements MigrationInterface {
  name = 'PhotoReferenceIndex1794933000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE INDEX "idx_users_photo_key" ON "users" ("photo_key")',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "idx_users_photo_key"');
  }
}
