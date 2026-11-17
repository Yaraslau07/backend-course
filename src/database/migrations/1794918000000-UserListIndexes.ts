import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Immutable keyset order plus bounded prefix searches (spec 1.7). */
export class UserListIndexes1794918000000 implements MigrationInterface {
  name = 'UserListIndexes1794918000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_users_created_at_id" ON "users" ("created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_id_created_at" ON "users" ("id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_status_created_at_id" ON "users" ("status", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_status_id_created_at" ON "users" ("status", "id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_email_prefix" ON "users" ("email" text_pattern_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_display_name_prefix" ON "users" (lower(normalize("display_name", NFC)) text_pattern_ops)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of [
      'idx_users_display_name_prefix',
      'idx_users_email_prefix',
      'idx_users_status_id_created_at',
      'idx_users_status_created_at_id',
      'idx_users_id_created_at',
      'idx_users_created_at_id',
    ]) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
  }
}
