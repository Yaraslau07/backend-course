import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The whole Part 1 schema in one migration (users, email challenges, RBAC, background jobs).
 * Generated from the entities, then tidied by hand: `migration:generate` emits the shared enum types
 * once per table that uses them. `npm run migration:check` proves the entities still match.
 * The reasons behind each constraint are next to the entity that declares it.
 */

const TIMESTAMP = 'TIMESTAMP(3) WITH TIME ZONE';
const RBAC_NAME = '^[a-z][a-z0-9._-]{0,63}$';
const CHALLENGE_TABLES = [
  'registration_challenges',
  'login_challenges',
  'email_change_challenges',
  'deletion_challenges',
] as const;

export class InitialSchema1794837923143 implements MigrationInterface {
  name = 'InitialSchema1794837923143';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* ---------- users ---------- */
    await queryRunner.query(
      `CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'blocked', 'deleting', 'deleted')`,
    );
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" text NOT NULL,
        "password_hash" text,
        "display_name" text,
        "photo_key" text,
        "status" "public"."user_status" NOT NULL,
        "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_users" PRIMARY KEY ("id"),
        CONSTRAINT "uq_users_email" UNIQUE ("email"),
        CONSTRAINT "ck_users_email" CHECK ("email" !~ '^\\s|\\s$' AND char_length("email") BETWEEN 3 AND 254),
        CONSTRAINT "ck_users_display_name" CHECK (char_length("display_name") BETWEEN 1 AND 80),
        CONSTRAINT "ck_users_deleted_state" CHECK (
          ("status" = 'deleted' AND "password_hash" IS NULL AND "display_name" IS NULL AND "photo_key" IS NULL)
          OR ("status" <> 'deleted' AND "password_hash" IS NOT NULL)
        )
      )
    `);

    /* ---------- email challenges ---------- */
    await queryRunner.query(
      `CREATE TYPE "public"."challenge_method" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."challenge_consumed_reason" AS ENUM('confirmed', 'replaced', 'attempts_exhausted', 'user_inactive', 'admin_override', 'email_conflict', 'job_exists')`,
    );
    for (const table of CHALLENGE_TABLES) {
      const emailChange = table === 'email_change_challenges';
      await queryRunner.query(`
        CREATE TABLE "${table}" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "method" "public"."challenge_method" NOT NULL,
          "secret_hash" bytea NOT NULL,
          "attempts" smallint NOT NULL DEFAULT 0,
          "last_sent_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
          "consumed_at" ${TIMESTAMP},
          "consumed_reason" "public"."challenge_consumed_reason",
          "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
          ${emailChange ? `"new_email" text NOT NULL,` : ''}
          CONSTRAINT "pk_${table}" PRIMARY KEY ("id"),
          CONSTRAINT "fk_${table}_user" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
          CONSTRAINT "ck_${table}_attempts" CHECK ("attempts" BETWEEN 0 AND 5),
          CONSTRAINT "ck_${table}_consumed" CHECK (("consumed_at" IS NULL) = ("consumed_reason" IS NULL)),
          CONSTRAINT "ck_${table}_secret_hash" CHECK (octet_length("secret_hash") = 32)
          ${
            emailChange
              ? `, CONSTRAINT "ck_${table}_new_email" CHECK ("new_email" !~ '^\\s|\\s$' AND char_length("new_email") BETWEEN 3 AND 254)`
              : ''
          }
        )
      `);
      await queryRunner.query(
        `CREATE UNIQUE INDEX "uq_${table}_outstanding" ON "${table}" ("user_id") WHERE "consumed_at" IS NULL`,
      );
      await queryRunner.query(
        `CREATE INDEX "idx_${table}_user" ON "${table}" ("user_id")`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX "idx_registration_challenges_secret_hash" ON "registration_challenges" ("secret_hash") WHERE "consumed_at" IS NULL`,
    );

    /* ---------- RBAC ---------- */
    for (const table of ['roles', 'permissions']) {
      await queryRunner.query(`
        CREATE TABLE "${table}" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "name" text NOT NULL,
          "description" text,
          "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
          "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
          CONSTRAINT "pk_${table}" PRIMARY KEY ("id"),
          CONSTRAINT "uq_${table}_name" UNIQUE ("name"),
          CONSTRAINT "ck_${table}_name" CHECK ("name" ~ '${RBAC_NAME}'),
          CONSTRAINT "ck_${table}_description" CHECK (char_length("description") BETWEEN 1 AND 500)
        )
      `);
    }
    await queryRunner.query(`
      CREATE TABLE "permission_actions" (
        "permission_id" uuid NOT NULL,
        "action" text NOT NULL,
        CONSTRAINT "pk_permission_actions" PRIMARY KEY ("permission_id", "action"),
        CONSTRAINT "fk_permission_actions_permission" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_permission_actions_action" CHECK ("action" ~ '${RBAC_NAME}')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "grants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        "all_actions" boolean NOT NULL,
        "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_grants" PRIMARY KEY ("id"),
        CONSTRAINT "uq_grants_role_permission" UNIQUE ("role_id", "permission_id"),
        CONSTRAINT "uq_grants_id_permission" UNIQUE ("id", "permission_id"),
        CONSTRAINT "fk_grants_role" FOREIGN KEY ("role_id") REFERENCES "roles"("id"),
        CONSTRAINT "fk_grants_permission" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_grants_permission" ON "grants" ("permission_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "grant_actions" (
        "grant_id" uuid NOT NULL,
        "action" text NOT NULL,
        "permission_id" uuid NOT NULL,
        CONSTRAINT "pk_grant_actions" PRIMARY KEY ("grant_id", "action"),
        CONSTRAINT "fk_grant_actions_grant" FOREIGN KEY ("grant_id", "permission_id") REFERENCES "grants"("id", "permission_id") ON DELETE CASCADE,
        CONSTRAINT "fk_grant_actions_permission_action" FOREIGN KEY ("permission_id", "action") REFERENCES "permission_actions"("permission_id", "action")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_grant_actions_permission_action" ON "grant_actions" ("permission_id", "action")`,
    );
    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "user_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_user_roles" PRIMARY KEY ("user_id", "role_id"),
        CONSTRAINT "fk_user_roles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "fk_user_roles_role" FOREIGN KEY ("role_id") REFERENCES "roles"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_user_roles_role" ON "user_roles" ("role_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "rbac_policy_state" (
        "id" smallint NOT NULL DEFAULT 1,
        "version" bigint NOT NULL DEFAULT 0,
        "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_rbac_policy_state" PRIMARY KEY ("id"),
        CONSTRAINT "ck_rbac_policy_state_single_row" CHECK ("id" = 1),
        CONSTRAINT "ck_rbac_policy_state_version" CHECK ("version" >= 0)
      )
    `);
    // The one row every RBAC change locks and bumps. It must exist before the app starts.
    await queryRunner.query(
      `INSERT INTO "rbac_policy_state" ("id", "version") VALUES (1, 0)`,
    );

    /* ---------- background jobs ---------- */
    await queryRunner.query(
      `CREATE TYPE "public"."deletion_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed')`,
    );
    await queryRunner.query(`
      CREATE TABLE "deletion_jobs" (
        "id" text NOT NULL,
        "user_id" uuid NOT NULL,
        "status" "public"."deletion_job_status" NOT NULL,
        "attempts" smallint NOT NULL DEFAULT 0,
        "lease_until" ${TIMESTAMP},
        "next_attempt_at" ${TIMESTAMP},
        "tombstone_email" text NOT NULL,
        "last_error_code" text,
        "finished_at" ${TIMESTAMP},
        "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_deletion_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_deletion_jobs_user" UNIQUE ("user_id"),
        CONSTRAINT "uq_deletion_jobs_tombstone_email" UNIQUE ("tombstone_email"),
        CONSTRAINT "fk_deletion_jobs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "ck_deletion_jobs_id" CHECK ("id" ~ '^[0-9a-f]{32}$'),
        CONSTRAINT "ck_deletion_jobs_tombstone_email" CHECK ("tombstone_email" ~ '^deleted\\.[0-9a-f]{32}@example\\.invalid$'),
        CONSTRAINT "ck_deletion_jobs_attempts" CHECK ("attempts" BETWEEN 0 AND 5),
        CONSTRAINT "ck_deletion_jobs_state" CHECK (
          ("status" = 'queued' AND "next_attempt_at" IS NOT NULL AND "lease_until" IS NULL AND "finished_at" IS NULL)
          OR ("status" = 'running' AND "lease_until" IS NOT NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NULL)
          OR ("status" = 'failed' AND "lease_until" IS NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NULL)
          OR ("status" = 'succeeded' AND "lease_until" IS NULL AND "next_attempt_at" IS NULL AND "finished_at" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_deletion_jobs_claim" ON "deletion_jobs" ("status", "next_attempt_at", "lease_until")`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."storage_cleanup_reason" AS ENUM('photo_replaced', 'photo_cleared')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."storage_cleanup_status" AS ENUM('queued', 'succeeded', 'failed')`,
    );
    await queryRunner.query(`
      CREATE TABLE "storage_cleanup_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "storage_key" text NOT NULL,
        "reason" "public"."storage_cleanup_reason" NOT NULL,
        "status" "public"."storage_cleanup_status" NOT NULL DEFAULT 'queued',
        "attempts" smallint NOT NULL DEFAULT 0,
        "next_attempt_at" ${TIMESTAMP} DEFAULT now(),
        "last_error_code" text,
        "created_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        "updated_at" ${TIMESTAMP} NOT NULL DEFAULT now(),
        CONSTRAINT "pk_storage_cleanup_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_storage_cleanup_jobs_attempts" CHECK ("attempts" BETWEEN 0 AND 5),
        CONSTRAINT "ck_storage_cleanup_jobs_state" CHECK (("status" = 'queued') = ("next_attempt_at" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_storage_cleanup_jobs_claim" ON "storage_cleanup_jobs" ("status", "next_attempt_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping a table drops its indexes and constraints; order follows the foreign keys.
    await queryRunner.query(`DROP TABLE "storage_cleanup_jobs"`);
    await queryRunner.query(`DROP TYPE "public"."storage_cleanup_status"`);
    await queryRunner.query(`DROP TYPE "public"."storage_cleanup_reason"`);
    await queryRunner.query(`DROP TABLE "deletion_jobs"`);
    await queryRunner.query(`DROP TYPE "public"."deletion_job_status"`);

    await queryRunner.query(`DROP TABLE "rbac_policy_state"`);
    await queryRunner.query(`DROP TABLE "user_roles"`);
    await queryRunner.query(`DROP TABLE "grant_actions"`);
    await queryRunner.query(`DROP TABLE "grants"`);
    await queryRunner.query(`DROP TABLE "permission_actions"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
    await queryRunner.query(`DROP TABLE "roles"`);

    for (const table of [...CHALLENGE_TABLES].reverse()) {
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
    await queryRunner.query(`DROP TYPE "public"."challenge_consumed_reason"`);
    await queryRunner.query(`DROP TYPE "public"."challenge_method"`);

    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."user_status"`);
  }
}
