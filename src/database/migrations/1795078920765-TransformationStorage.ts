import { MigrationInterface, QueryRunner } from 'typeorm';

/** Spec 2.4 (C19): the storage columns of the history row, the worker queue and the expiry sweep. */
export class TransformationStorage1795078920765 implements MigrationInterface {
  name = 'TransformationStorage1795078920765';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transformation_storage_status" AS ENUM('not_requested', 'pending', 'available', 'error')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "storage_status" "public"."transformation_storage_status" NOT NULL DEFAULT 'not_requested'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "stored_file_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "stored_file_until" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "storage_attempts" smallint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "storage_next_attempt_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_transformations_stored_file_key" ON "transformations" ("stored_file_key") WHERE "stored_file_key" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transformations_storage_status_until" ON "transformations" ("storage_status", "stored_file_until") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD CONSTRAINT "ck_transformations_storage_attempts" CHECK ("storage_attempts" BETWEEN 0 AND 5)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD CONSTRAINT "ck_transformations_storage" CHECK (("storage_status" = 'not_requested' AND "stored_file_key" IS NULL AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NULL) OR ("status" = 'success' AND (("storage_status" = 'pending' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NOT NULL) OR ("storage_status" = 'available' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NOT NULL AND "storage_next_attempt_at" IS NULL) OR ("storage_status" = 'error' AND "stored_file_until" IS NULL AND "storage_next_attempt_at" IS NULL))))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP CONSTRAINT "ck_transformations_storage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP CONSTRAINT "ck_transformations_storage_attempts"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_transformations_storage_status_until"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_transformations_stored_file_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "storage_next_attempt_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "storage_attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "stored_file_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "stored_file_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "storage_status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."transformation_storage_status"`,
    );
  }
}
