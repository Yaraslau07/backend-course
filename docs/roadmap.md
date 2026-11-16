# Roadmap

The order the assignment is being built in, and why. Update the status column as phases land. Details for each step live in `docs/specs/<lesson>.md`; shared rules live in `docs/invariants.md`.

| Checkpoint | Phase | Spec | Status |
|---|---|---|---|
| C0. Foundation | 0 | | ✅ done (PR #1) |
| C1. Part 1 schema | 1a | 1.0–1.2, 1.5, 1.6 | ✅ done |
| C2. Error envelope | 1b | | ✅ done |
| C3. Route declarations | 1b | 1.3 | ✅ done |
| C4. CSRF guard | 1b | 1.2, 1.3 | ✅ done |
| C5. Throttling | 1b | 1.0–1.7, 2.3 | ✅ done |
| C6. MailService | 1b | | ⏭ next |
| C7. Email challenge engine | 1c | 1.0, 1.2, 1.5, 1.6 | pending |
| C8. Registration | 1c | 1.0 | pending |
| C9. Authentication | 1c | 1.2 | pending |
| C10. RBAC | 1c | 1.1 | pending |
| C11. Authorization chain | 1c | 1.3 | pending |
| C12. View and list | 2 | 1.4, 1.7 | pending |
| C13. Update | 2 | 1.5 | pending |
| C14. Delete | 2 | 1.6 | pending |
| C15. Transformation framework | 3 | 2.0 | pending |
| C16. Text | 3 | 2.1 | pending |
| C17. Images | 3 | 2.2 | pending |
| C18. History | 3 | 2.3 | pending |
| C19. Storage | 3 | 2.4 | pending |
| C20. Final audit | | all | pending |

Each checkpoint is one branch and one PR. The next one starts only after the previous PR is merged.

## The gate every checkpoint must pass

1. **Tests first.** Every status code, check-order rule and edge case in the lesson's sections 1.3–1.6 has a test, written from the spec and committed failing (`test:` commit) before the implementation.
2. **Local commands pass:** `npm run lint` with no warnings, `npm run typecheck`, `npm run test:cov` (≥ 80%), `npm run test:e2e`, `npm run build`.
3. **Spec audit in the PR description:** a table walking the lesson's error list (§1.4), logging rules (§1.5) and non-functional requirements (§1.6), each row pointing at the code and the test. Anything left out goes into `docs/known-gaps.md`.
4. **Log-leak check:** e2e tests capture the logs and assert that none of the "never log" values from `docs/invariants.md` appear (the helper arrives in C2).
5. **Manual smoke** from a committed HTTP-client file in `http/`, against `npm run start:dev`.
6. **Docs updated:** `docs/decisions.md`, `docs/known-gaps.md`, the table above, and `CLAUDE.md` if a rule or gotcha changed.
7. **CI green on the PR.**

`/code-review` and `/security-review` run at the end of each phase (after C1, C6, C11, C14, C19), and individually on C7, C9, C10, C11 and C14.

Schema checkpoints add: `migration:run` → `migration:revert` → `migration:run` on an empty database, and `npm run migration:check` reporting no drift.

## Phase 0: Foundation ✅

Config and keys, the readiness registry, logging, app bootstrap, Docker, CI, git hooks and docs. See PR #1 and decisions D1–D11.

## Phase 1a: Database schema (Part 1) ✅

Done in C1; see `docs/schema.md` and decisions D12–D17.

One initial migration plus entities for:
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

## Phase 1b: Shared framework pieces ⏭

**Sequential.** These were deferred from Phase 0; see `docs/known-gaps.md`.

1. ✅ **Error envelope** (C2, D18–D22): a global filter producing `{ statusCode, code, message, requestId }` plus safe extras; Postgres `23505` → `409`, an unavailable database → `503`.
2. ✅ **Route declarations** (C3, D23–D26): `@Public()`, `@Internal()`, `@RequirePermission(permission, action)`, `@Receipt(header)`; a startup scan behind the `route_declarations` readiness check; a global guard that fails closed on protected routes until C11.
3. ✅ **CSRF guard** (C4, D27–D28): cross-origin writes need an exact `Origin` and `X-CSRF-Protection: 1`, otherwise `403 csrf_rejected`. Public writes are checked in the route guard now; protected ones after identity in C11.
4. ✅ **Throttling** (C5, D29–D32): every spec limit as a named policy; exact sliding windows in Postgres with HMAC keys; `@RateLimit()` for IP-keyed limits on routes, `RateLimiter` for custom ones; cleanup every 5 minutes.
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

The three features are independent of each other, but are built in order (C12 → C13 → C14), each merged before the next starts.

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

The shared projector and the storage interface land in 2a, so 2b and 2c build on them.

## Phase 3: File transformations (Part 2)

1. **Framework** (spec 2.0, sequential):
   - the `transformations` migration
   - the converter interface and registry
   - a worker-thread pool (piscina), temp files and cleanup
   - history writes
   - the `transformations` permission bootstrap
   - the user-data eraser
2. **Text, then images** (independent of each other):
   - 2.1 text: CSV, JSON, XML and YAML in all 12 directions, using papaparse, fast-xml-parser (no DTD) and yaml (safe load)
   - 2.2 images: png→jpeg, jpeg→png, svg→png/jpeg, using sharp and resvg (no network, unsafe SVG rejected)
3. **History** (spec 2.3, sequential): own and admin history, cursor pagination, 90-day retention.
4. **Storage** (spec 2.4, sequential): `save=true`, a background upload worker over the `pending` rows, own and admin download, retention.
