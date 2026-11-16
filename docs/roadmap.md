# Roadmap

The order the assignment is being built in, and why. Update the status column as phases land. Details for each step live in `docs/specs/<lesson>.md`; shared rules live in `docs/invariants.md`.

| Phase | Status |
|---|---|
| 0. Foundation | ✅ done (PR #1) |
| 1a. Database schema (Part 1) | ⏭ next |
| 1b. Shared framework pieces | pending |
| 1c. Core auth and access | pending |
| 2. User features | pending |
| 3. File transformations (Part 2) | pending |

## How to work

- **For every feature, write the tests from the spec first**, then implement until they pass. Ideally one agent writes the tests and another implements, so tests don't end up matching the implementation's bugs. Cover every status code and edge case the spec lists (the 5th OTP attempt, check order, 403-before-404).
- **One branch and PR per step.** CI must be green: coverage ≥ 80%, e2e passing.
- After each phase, run `/code-review` and `/security-review`, and audit the result against the spec: walk the section's error list and logging rules, and point to the code that satisfies each item.
- Record every non-obvious choice in `docs/decisions.md`, update `docs/known-gaps.md`, and update the status table above.

## Phase 0: Foundation ✅

Config and keys, the readiness registry, logging, app bootstrap, Docker, CI, git hooks and docs. See PR #1 and decisions D1–D11.

## Phase 1a: Database schema (Part 1) ⏭

**Sequential.** Do this first: parallel work would collide on migrations.

Write one initial migration plus entities for:
- `users`:
  - uuid id; unique normalized email (text)
  - `password_hash` (nullable only when `status = deleted`)
  - `display_name`, `photo_key`
  - `status` enum: `pending`, `active`, `blocked`, `deleting`, `deleted`
  - `created_at` and `updated_at` as `timestamptz`, both set from the database clock
  - a CHECK constraint for the deleted state (`password_hash`, `display_name` and `photo_key` are null)
- the four challenge tables: registration, login, email change, deletion.
  - Columns: `id`, `user_id`, `method`, `secret_hash`, `attempts`, `last_sent_at`, `consumed_at`, `consumed_reason`.
  - Plus the scenario's own fields (the email-change target address, the method recorded at creation).
  - **A partial unique index allows only one outstanding challenge per user.**
- RBAC:
  - `roles`, `permissions`, `permission_actions`, `grants` (with an `all_actions` flag), `grant_actions`, `user_roles`
  - `rbac_policy_state`: a single row with `version`, which is also the shared lock
  - indexes on user roles, grants and unique names
- `deletion_jobs`:
  - one per user; id = `Idempotency-Key`
  - status, attempts, lease, next attempt, tombstone email, last error code, finished at
  - claim index on `(status, next_attempt_at, lease_until)`
- `storage_cleanup_jobs`: key, reason, status, attempts, next attempt.

The Part 2 `transformations` table gets its own migration in Phase 3.

Specs to read: 1.0, 1.1, 1.2, 1.5, 1.6 (the schema-related parts) and `docs/invariants.md`.

## Phase 1b: Shared framework pieces

**Sequential.** These were deferred from Phase 0; see `docs/known-gaps.md`.

1. **Error envelope:** a global filter producing `{ statusCode, code, message, requestId }` plus safe extras; map Postgres `23505` to `409`.
2. **Route declarations:**
   - `@Public()`, `@RequirePermission(permission, action)`, `@Receipt(header)`
   - a startup scan registered as a readiness check, failing readiness on a missing or conflicting declaration
   - mark `/health/*` accordingly
3. **CSRF guard:** cross-origin writes need an exact `Origin` and `X-CSRF-Protection: 1`, otherwise `403 csrf_rejected`.
4. **Throttling:** per-route, per-IP, per-email+IP and per-user limits, built on `@nestjs/throttler` with custom trackers.
5. **MailService:** nodemailer transport with a 2 s timeout, OTP and magic-link templates, an `smtp` readiness check. Tests read mail through the Mailpit API.

## Phase 1c: Core auth and access

**Sequential.** Each step depends on the previous one.

1. **Email challenge engine:** one generic implementation, configured per scenario (HMAC key, table, method). It covers:
   - issue, resend, confirm
   - HMAC-SHA256 with a constant-time comparison
   - 5 attempts, where the 5th can still succeed
   - TTL measured from `last_sent_at`
   - `consumed_reason`
   - a 60 s cooldown
   - committing before SMTP, and keeping the challenge with a 503 if SMTP fails
   - the user → challenge lock order
   - claim-then-act consumption

   It's reused by registration, login, email change and deletion, which makes it the biggest single time saver. A pattern to borrow is the email verification service in touch-grass-back, reworked for HMAC, attempt ids, `consumed_reason` and the 5th-attempt rule.
2. **Registration** (spec 1.0): argon2 hashing, the password policy (over-long input is rejected), 201 or 202, the 409 on a duplicate email.
3. **Authentication** (spec 1.2):
   - login with exactly one argon2 verify per attempt (a dummy hash for unknown users) and the optional email step
   - stateless HS256 access and refresh JWTs with separate secrets, `token_use`, 30 s tolerance and cookies
   - refresh, logout
   - the access guard (`401 invalid_session`, or `503` when the DB is down)
4. **RBAC** (spec 1.1):
   - the bootstrap
   - a snapshot plus version check before each request, with an atomic reload
   - the admin CRUD for roles, permissions, grants and user roles
   - the last-`rbac@manage`-holder guard
   - the `user` role assigned on activation
5. **Authorization chain** (spec 1.3): access → active user → CSRF → RBAC → resource → ownership, with `503 authorization_unavailable`.

## Phase 2: User features

**Can run in parallel**, one worktree and branch each, merged one at a time.

- **2a. View and list** (specs 1.4 and 1.7): the safe profile projector, `GET /users/{id}`, the photo download, `GET /admin/users` with the HMAC keyset cursor and key ring.
- **2b. Update** (spec 1.5):
  - PATCH with a field whitelist (self and admin)
  - email change through the challenge engine
  - photo upload with sharp (WebP), clear photo
  - the storage adapter (local and S3/MinIO), the `storage_cleanup_jobs` worker and the orphan sweep
- **2c. Delete** (spec 1.6):
  - self deletion through the challenge engine; admin DELETE
  - `Idempotency-Key`
  - the `deleting` barrier
  - the deletion worker with a lease, the eraser registry and the readiness check for missing erasers
  - anonymization with a tombstone
  - the receipt-based status endpoint

The shared projector and storage adapter are best done first in 2a/2b, or agreed up front, so the parallel branches don't each invent their own.

## Phase 3: File transformations (Part 2)

1. **Framework** (spec 2.0, sequential):
   - the `transformations` migration
   - the converter interface and registry
   - a worker-thread pool (piscina), temp files and cleanup
   - history writes
   - the `transformations` permission bootstrap
   - the user-data eraser
2. **Text and images, in parallel:**
   - 2.1 text: CSV, JSON, XML and YAML in all 12 directions, using papaparse, fast-xml-parser (no DTD) and yaml (safe load)
   - 2.2 images: png→jpeg, jpeg→png, svg→png/jpeg, using sharp and resvg (no network, unsafe SVG rejected)
3. **History** (spec 2.3, sequential): own and admin history, cursor pagination, 90-day retention.
4. **Storage** (spec 2.4, sequential): `save=true`, a background upload worker over the `pending` rows, own and admin download, retention.
