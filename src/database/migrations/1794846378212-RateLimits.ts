import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sliding-window rate-limit counters (D29); see `RateLimitCounter` for the columns. */
export class RateLimits1794846378212 implements MigrationInterface {
  name = 'RateLimits1794846378212';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rate_limits" (
        "bucket" text NOT NULL,
        "key" text NOT NULL,
        "hits" TIMESTAMP WITH TIME ZONE array NOT NULL,
        "last_allowed" boolean NOT NULL,
        "expires_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        CONSTRAINT "pk_rate_limits" PRIMARY KEY ("bucket", "key"),
        CONSTRAINT "ck_rate_limits_key" CHECK ("key" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_rate_limits_expires_at" ON "rate_limits" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rate_limits"`);
  }
}
