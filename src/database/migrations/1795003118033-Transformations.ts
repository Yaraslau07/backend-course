import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Spec 2.0 §1.3.3, §1.6: the transformation history (C15). Storage columns come with spec 2.4. */
export class Transformations1795003118033 implements MigrationInterface {
  name = 'Transformations1795003118033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transformation_type" AS ENUM('file', 'image')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transformation_status" AS ENUM('success', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transformations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "type" "public"."transformation_type" NOT NULL, "source_format" text NOT NULL, "target_format" text NOT NULL, "status" "public"."transformation_status" NOT NULL, "input_size" bigint NOT NULL, "output_size" bigint, "duration_ms" integer NOT NULL, "error_code" text, "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_transformations_error_code" CHECK ("error_code" ~ '^[a-z][a-z0-9_]{0,63}$'), CONSTRAINT "ck_transformations_outcome" CHECK (("status" = 'success' AND "error_code" IS NULL AND "output_size" IS NOT NULL) OR ("status" = 'error' AND "error_code" IS NOT NULL AND "output_size" IS NULL)), CONSTRAINT "ck_transformations_sizes" CHECK ("input_size" >= 0 AND ("output_size" IS NULL OR "output_size" >= 0) AND "duration_ms" >= 0), CONSTRAINT "ck_transformations_formats" CHECK ("source_format" ~ '^[a-z0-9]{1,16}$' AND "target_format" ~ '^[a-z0-9]{1,16}$' AND "source_format" <> "target_format"), CONSTRAINT "pk_transformations" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_transformations_user_created_at_id" ON "transformations" ("user_id", "created_at", "id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD CONSTRAINT "fk_transformations_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP CONSTRAINT "fk_transformations_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_transformations_user_created_at_id"`,
    );
    await queryRunner.query(`DROP TABLE "transformations"`);
    await queryRunner.query(`DROP TYPE "public"."transformation_status"`);
    await queryRunner.query(`DROP TYPE "public"."transformation_type"`);
  }
}
