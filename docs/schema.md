# Database schema

What each table is for and which spec rule each constraint enforces. The source of truth is the entities (`src/modules/*/entities/*.entity.ts`) and the migrations (`src/database/migrations/`); `npm run migration:check` fails when they disagree, and `test/schema.e2e-spec.ts` tests every constraint below against Postgres.

Conventions:
- Ids are `uuid` from `gen_random_uuid()` (D15).
- Timestamps are `timestamptz(3)` defaulting to `now()` (D12).
- Constraint and index names are `pk_`, `uq_`, `fk_`, `ck_`, `idx_` plus the table name.
- Foreign keys don't cascade unless stated, so deleting something still in use fails.

## users

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `email` | text | normalized; a tombstone address after deletion |
| `password_hash` | text, nullable | argon2 encoded string |
| `display_name` | text, nullable | |
| `photo_key` | text, nullable | opaque storage key |
| `status` | `user_status` | `pending`, `active`, `blocked`, `deleting`, `deleted` |
| `created_at`, `updated_at` | timestamptz(3) | |

| Constraint | Rule | Spec |
|---|---|---|
| `uq_users_email` | one account per email, including `pending` ones | 1.0 |
| `ck_users_email` | no leading or trailing whitespace of any kind, 3 to 254 characters | 1.0 |
| `ck_users_display_name` | 1 to 80 code points | 1.5 |
| `ck_users_deleted_state` | `password_hash` is null only when `deleted`; a `deleted` row has no name or photo | 1.6 |

Lowercasing, NFC and control-character rules are applied by the application, not checked here: the database's notion of "lowercase" depends on collation and could disagree with the app's.

C12 adds the following indexes for spec 1.7. Both ascending and descending traversals use the same B-tree in opposite directions; there is no OFFSET or count query.

| Index | Purpose |
|---|---|
| `idx_users_created_at_id` | keyset order `(created_at, id)` |
| `idx_users_id_created_at` | keyset order `(id, created_at)` |
| `idx_users_status_created_at_id` | status-filtered creation order |
| `idx_users_status_id_created_at` | status-filtered id order |
| `idx_users_email_prefix` | literal email prefix, `text_pattern_ops` |
| `idx_users_display_name_prefix` | literal prefix on `lower(normalize(display_name, NFC))`, `text_pattern_ops` |

The expression and opclass indexes have `synchronize: false` index declarations because TypeORM cannot represent their definitions. The migration owns their SQL. The other four are fully described by entity metadata and checked for drift.

C13 adds `idx_users_photo_key` for cleanup/reference checks. It does not add a new job table: photo replacement/clearing writes the existing `storage_cleanup_jobs` row in the same transaction as dropping the reference. Workers hold a `FOR UPDATE SKIP LOCKED` job lock through bounded storage deletion, then commit success or a one-minute retry; the fifth unsuccessful attempt becomes `failed` with `next_attempt_at = NULL`.

## Email challenges

Four tables with the same columns: `registration_challenges`, `login_challenges`, `email_change_challenges`, `deletion_challenges` (D13).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | the `attemptId` / `challengeId` clients see |
| `user_id` | uuid | → `users` |
| `method` | `challenge_method` | `otp` or `magic_link`, fixed at creation |
| `secret_hash` | bytea | HMAC-SHA256 under the scenario's key |
| `attempts` | smallint | wrong OTP entries since the last send |
| `last_sent_at` | timestamptz(3) | start of the 10 min TTL and the 60 s cooldown |
| `consumed_at`, `consumed_reason` | timestamptz(3), `challenge_consumed_reason` | both null while outstanding |
| `created_at` | timestamptz(3) | |
| `new_email` | text | `email_change_challenges` only: the target address |

| Constraint (per table) | Rule |
|---|---|
| `uq_<table>_outstanding` | partial unique index on `user_id` where `consumed_at IS NULL`: one outstanding challenge per user |
| `ck_<table>_attempts` | 0 to 5 |
| `ck_<table>_consumed` | `consumed_at` and `consumed_reason` are set together |
| `ck_<table>_secret_hash` | exactly 32 bytes, so a raw OTP or token can't be stored by mistake |
| `idx_<table>_user` | all of a user's challenges, for anonymization |
| `idx_registration_challenges_secret_hash` | a registration magic link carries only the token, so the row is found by its HMAC |

## RBAC

| Table | Purpose |
|---|---|
| `roles` | `name` (unique, `^[a-z][a-z0-9._-]{0,63}$`), `description` (1 to 500 characters or null) |
| `permissions` | same shape as `roles` |
| `permission_actions` | `(permission_id, action)`: the valid actions of a permission; deleted with the permission |
| `grants` | `(role_id, permission_id)` unique, plus `all_actions` |
| `grant_actions` | `(grant_id, action)` plus `permission_id`: the explicit list of a limited grant; deleted with the grant |
| `user_roles` | `(user_id, role_id)`; `idx_user_roles_role` answers "is this role assigned to anyone" |
| `rbac_policy_state` | one row (`id = 1`) with `version`; locking it serializes RBAC changes, blocking and deletion |

What the foreign keys guarantee (spec 1.1, D14):
- A role with grants or users can't be deleted (`fk_grants_role`, `fk_user_roles_role`).
- A permission with grants can't be deleted (`fk_grants_permission`).
- A grant can list only actions of its own permission (`fk_grant_actions_grant` + `fk_grant_actions_permission_action`).
- An action that a grant lists explicitly can't be removed from its permission (`fk_grant_actions_permission_action`).

## deletion_jobs

One row per user being deleted (spec 1.6).

| Column | Notes |
|---|---|
| `id` | text: the client's `Idempotency-Key`, 32 lowercase hex (`ck_deletion_jobs_id`) |
| `user_id` | → `users`, unique (`uq_deletion_jobs_user`) |
| `status` | `queued`, `running`, `succeeded`, `failed` |
| `attempts` | automatic starts, 0 to 5; the claim must fail a job that already used 5 instead of starting it again |
| `lease_until`, `next_attempt_at`, `finished_at` | which ones are set depends on `status` (`ck_deletion_jobs_state`) |
| `tombstone_email` | unique, `deleted.<32 hex>@example.invalid` |
| `last_error_code` | a safe code, never a library message |

`idx_deletion_jobs_claim (status, next_attempt_at, lease_until)` is what the worker claims through.

## storage_cleanup_jobs

"Delete this object", written in the same transaction that drops the reference (spec 1.5).

| Column | Notes |
|---|---|
| `storage_key` | the object to delete; never logged |
| `reason` | `photo_replaced` or `photo_cleared` |
| `status` | `queued`, `succeeded`, `failed` |
| `attempts` | 0 to 5 |
| `next_attempt_at` | set exactly while `queued` (`ck_storage_cleanup_jobs_state`) |

`idx_storage_cleanup_jobs_claim (status, next_attempt_at)` is the worker's index.

## rate_limits

One sliding-window counter per policy and key (D29, D31).

| Column | Notes |
|---|---|
| `bucket` | the policy name, for example `login_ip` |
| `key` | HMAC-SHA256 hex of the key parts (`ck_rate_limits_key`); never a raw IP, email or id |
| `hits` | `timestamptz[]`: allowed hits still inside the window, oldest first, at most `limit` |
| `last_allowed` | whether the latest consume was allowed, so one statement can decide and report |
| `expires_at` | when the newest hit leaves the window; `idx_rate_limits_expires_at` serves the cleanup |

`hits` is plain `timestamptz[]`, not `timestamptz(3)[]`: TypeORM can't read an array column's precision back, so the latter would always show as drift. The values never leave the database.
