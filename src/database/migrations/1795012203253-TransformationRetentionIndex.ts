import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Spec 2.3 §1.6 (C18): retention finds old history rows across users. */
export class TransformationRetentionIndex1795012203253 implements MigrationInterface {
  name = 'TransformationRetentionIndex1795012203253';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_transformations_created_at" ON "transformations" ("created_at") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_transformations_created_at"`,
    );
  }
}
