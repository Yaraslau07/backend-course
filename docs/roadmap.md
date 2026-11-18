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
| C6. MailService | 1b | 1.0, 1.2, 1.5, 1.6 | ✅ done |
| C7. Email challenge engine | 1c | 1.0, 1.2, 1.5, 1.6 | ✅ done |
| C8. Registration | 1c | 1.0 | ✅ done |
| C9. Authentication | 1c | 1.2 | ✅ done |
| C10. RBAC | 1c | 1.1 | ✅ done |
| C11. Authorization chain | 1c | 1.3 | ✅ done |
| C12. View and list | 2 | 1.4, 1.7 | ✅ done (PR #13) |
| C13. Update | 2 | 1.5 | ✅ done (PR #14) |
| C14. Delete | 2 | 1.6 | ✅ done (PR #15) |
| C15. Transformation framework | 3 | 2.0 | ⏳ PR open; awaiting review/merge |
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

## Working agreement (read this first in a new session)

How the author and the agent work, as agreed on 2026-11-16. A new session continues from here; nothing else is needed.

**Picking up:**
1. Run `gh pr list --state open`. If a checkpoint PR is still open, it is waiting for the author's review: don't start the next checkpoint until they say it is merged.
2. Otherwise `git checkout main && git pull`, find the first `⏭ next` row in the table above, and read its spec in `docs/specs/`, `docs/invariants.md`, `docs/known-gaps.md` and the related decisions.

**Each checkpoint:**
1. **Branch** `feat/<short-name>` from a fresh `main`.
2. **Tests first,** in a `test:` commit that fails:
   - unit tests in `src/**/*.spec.ts`;
   - e2e tests in `test/*.e2e-spec.ts`, using `createTestApp()`, `LogCapture`, `waitForMail()` and `resetRateLimits()`;
   - signature-only stubs (`throw new Error('not implemented')`) so it compiles and passes lint.
3. **Implement** in a `feat:` commit, until everything passes.
4. **Run the gate above.** Run the e2e suite 3 to 5 times when concurrency or timing is involved. Unit coverage must stay at least 80% on every metric (branches is the one that slips); add unit tests with scripted fakes when logic is only covered by e2e.
5. **Smoke test:** run `npm run build && node dist/main.js` with the author's `.env`; override flags with environment variables (e.g. `REGISTRATION_EMAIL_CONFIRMATION_ENABLED=true`) and read mail from Mailpit's API. Add the requests to an `http/*.http` file.
6. **Docs:** add a numbered decision for every non-obvious choice. Never rewrite an old decision; add an amending entry instead.
7. **Reviews:** when the checkpoint is in the review list above, run `/code-review medium main...HEAD` and `/security-review`, fix the findings in a `fix:` commit, and record them in a decision. Phase-end reviews cover the whole phase range (e.g. `<merge commit before the phase>...HEAD`).
8. **Push, open the PR, wait for CI to pass, then stop.** The PR description has: what changed, the spec audit table (rule → where → test), the gate checklist, review findings, and anything changed after the test commit. Then report to the author in plain words and wait for "merged, continue".

**Conventions:**
- Conventional commits with a lowercase subject (commitlint rejects sentence case).
- Commits end with the `Co-Authored-By` trailer; PR descriptions end with the Claude Code line.
- Don't decide silently: when a spec is ambiguous in a way that changes behaviour, ask the author before implementing.
- Pin new dependencies to a release at least two weeks old, and prefer packages without install scripts (the Dockerfile uses `npm ci --ignore-scripts`).

**Things that need the author:**
- **C13 (S3 storage):** setup completed with AWS S3; credentials stay in local `.env`. See `docs/storage-setup.md`. CI uses local/fake storage and needs no real AWS secrets; a future deployment must supply protected credentials.
- **Any new secret:** the author adds it to their `.env` (`npm run keys:generate` prints one). Tell them before merging, because the app refuses to boot without it.

**Local environment, as of 2026-11-16:**
- docker-compose runs Postgres (`app` and `app_test`) and Mailpit.
- The `app` database has all migrations applied.
- `.env` has every key, including `RATE_LIMIT_KEY_HMAC_KEY`, with `REGISTRATION_EMAIL_CONFIRMATION_ENABLED=false`.

**Tooling traps that cost time before:**
- `prettier --write src` also reformats the `README.MD` files under `src/`. Use `"src/**/*.ts"`.
- Nest's ConfigModule reads the environment once per process, so use `createTestApp({ env })` instead of changing `process.env`.
- A Fastify 413 over a real socket can surface as `ECONNRESET`; use `app.inject()`.
- TypeORM can't read an array column's precision back, so declare arrays without `precision` to avoid permanent drift.
- Postgres `now()` is the transaction's start time; use `clock_timestamp()` when a lock wait matters.

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

## Phase 1b: Shared framework pieces ✅

**Sequential.** These were deferred from Phase 0; see `docs/known-gaps.md`.

1. ✅ **Error envelope** (C2, D18–D22): a global filter producing `{ statusCode, code, message, requestId }` plus safe extras; Postgres `23505` → `409`, an unavailable database → `503`.
2. ✅ **Route declarations** (C3, D23–D26): `@Public()`, `@Internal()`, `@RequirePermission(permission, action)`, `@Receipt(header)`; a startup scan behind the `route_declarations` readiness check; a global guard that fails closed on protected routes until C11.
3. ✅ **CSRF guard** (C4, D27–D28): cross-origin writes need an exact `Origin` and `X-CSRF-Protection: 1`, otherwise `403 csrf_rejected`. Public writes are checked in the route guard now; protected ones after identity in C11.
4. ✅ **Throttling** (C5, D29–D32): every spec limit as a named policy; exact sliding windows in Postgres with HMAC keys; `@RateLimit()` for IP-keyed limits on routes, `RateLimiter` for custom ones; cleanup every 5 minutes.
5. ✅ **MailService** (C6, D33–D36): nodemailer with a 2 s limit, OTP and magic-link templates (token in the URL fragment), an `smtp` readiness check. Tests read mail through the Mailpit API.

## Phase 1c: Core auth and access ✅

**Sequential.** Each step depends on the previous one.

1. ✅ **Email challenge engine** (C7, D38): one generic implementation, configured per scenario (HMAC key, table, method). It covers:
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
2. ✅ **Registration** (spec 1.0; C8, D40–D41): argon2 hashing, the password policy (over-long input is rejected), 201 or 202, the 409 on a duplicate email.
3. ✅ **Authentication** (spec 1.2; C9, D42–D43):
   - login with exactly one argon2 verify per attempt (a dummy hash for unknown users) and the optional email step
   - stateless HS256 access and refresh JWTs with separate secrets, `token_use`, 30 s tolerance and cookies
   - refresh, logout
   - the access guard (`401 invalid_session`, or `503` when the DB is down)
4. ✅ **RBAC** (spec 1.1; C10, D45–D46; the chain now runs access → CSRF → IP limits → RBAC):
   - the bootstrap
   - a snapshot plus version check before each request, with an atomic reload
   - the admin CRUD for roles, permissions, grants and user roles
   - the last-`rbac@manage`-holder guard
   - the `user` role assigned on activation
5. ✅ **Authorization chain** (spec 1.3; C11, D48–D49): access → active user → CSRF → IP and user rate limits → RBAC → resource → ownership, with `503 authorization_unavailable`. It replaces the fail-closed `protectedChain` in `route-access.guard.ts`, and must enforce the route's `@RateLimit` policies, both kinds (D37).

## Phase 2: User features

The three features are independent of each other, but are built in order (C12 → C13 → C14), each merged before the next starts.

- **2a. View and list** (specs 1.4 and 1.7; C12 implemented, D51): the safe profile projector, `GET /users/{id}`, the protected photo stream, `GET /admin/users` with the HMAC keyset cursor and key ring. Search/order indexes and the read/delete storage port are in place. Local reads work in development/test; production S3 and uploads arrive in C13.
- **2b. Update** (spec 1.5; C13 implemented, D52–D56):
  - PATCH with a field whitelist (self and admin)
  - email change through the challenge engine
  - photo upload with sharp (WebP), clear photo
  - the storage adapter (local and S3/MinIO), the `storage_cleanup_jobs` worker and the orphan sweep

C12 and C13 are merged.

- **2c. Delete** (spec 1.6; C14 implemented, D57–D63):
  - self deletion through the challenge engine; admin DELETE
  - `Idempotency-Key`
  - the `deleting` barrier
  - the deletion worker with a lease, the eraser registry and the readiness check for missing erasers
  - anonymization with a tombstone
  - the receipt-based status endpoint

The shared projector and the storage interface land in 2a, so 2b and 2c build on them.

## Phase 3: File transformations (Part 2)

1. **Framework** (spec 2.0; C15 implemented, D65–D69):
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
