# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repo: the codebase's real constraints and the history worth knowing. Record **why** next to every non-obvious rule; the author has to justify every decision to a mentor.

## What this is

The backend course assignment: a NestJS monolith on Postgres, driven entirely through an HTTP client.
- **Part 1:** registration, login (JWT cookies), RBAC, authorization chain, user profile view/update/delete, admin user list.
- **Part 2:** text and image transformations, their history, and saved results.

The full contract is in `docs/specs/` (one file per lesson; `00-overview.md` first). The cross-cutting rules are in `docs/invariants.md`. **Read the spec file for the feature you're touching before writing code**, because the specs are precise about status codes, check order and what may be logged.

## Stack

NestJS 11 on **Fastify** (not Express), TypeORM 0.3 + Postgres 18, Joi config, nestjs-pino, Swagger. Package manager **npm**, Node **22**. Path alias `@/` → `src/`.

## Commands

```bash
docker compose up -d        # Postgres (app + app_test DBs) and Mailpit (http://localhost:8025)
npm run keys:generate       # print fresh secret keys for .env
npm run start:dev           # watch mode
npm run typecheck
npm run lint
npm test                    # unit tests
npm run test:cov            # unit tests + 80% coverage gate
npm run test:e2e            # needs `docker compose up -d`; uses .env.test and the app_test DB; migrates it first
npm run migration:generate  # needs a reachable DB; writes src/database/migrations/<ts>-Migration.ts
npm run migration:run       # the dev DB from .env; prefix NODE_ENV=test for app_test
npm run migration:check     # fails if entities and the migrated DB differ (CI runs it)
```

## Hard rules

- **Schema changes go through migrations, never `synchronize`.** `buildDataSourceOptions()` hard-codes `synchronize: false`.
- **Transactions are explicit** (`dataSource.transaction(async (manager) => …)`), and rows are locked in the order in `docs/invariants.md` (policy state → user → challenge → job). Don't add `typeorm-transactional` back (decision D3).
- **Config enters only through `validate()`** in `src/core/config/config.validation.ts`. Never read `process.env` in app code. A new variable goes into:
  - `AppConfig` and `configSchema`
  - `.env.example`
  - `.env.test`
  - `.github/workflows/ci.yml`, if CI needs a non-default value (the Docker smoke job builds its own env)
- **Application signing/HMAC keys are base64url, ≥ 32 decoded bytes, and all different.** A new application key also goes into `SECRET_KEY_NAMES` and `scripts/generate-keys.mjs`. AWS-issued credentials have their own format and stay outside that generator/key list (D53). Never put a real key in a committed file. `.env.test` keys are test-only.
- **Never log** the values listed under "Logging" in `docs/invariants.md`: emails, passwords, secrets, tokens, cookies, full URLs and query strings, bodies, headers, storage keys. Log ids, categories and counts.
- **Errors go through `AppException(code, extras?)`** (`src/core/errors/`). The code fixes the status and the message; a new code goes into `ERROR_CATALOGUE`, a new extra into `ErrorExtras`. Never put a request value, a library message or a constraint name into a response (D18).
- **Every route needs an access declaration** (`src/core/authorization/route-access.ts`): `@Public()`, `@Internal()`, one `@RequirePermission(permission, action)`, or `@Receipt(header)` with at most one pair. Without one, readiness fails and the route answers 503. Test-only probe routes need one too.
- **CSRF is in the guard** (`src/core/authorization/csrf.ts`), never in a handler. Don't add a second check, and don't skip it for "safe" writes; if a write must be callable cross-origin, its origin goes into `CORS_ORIGINS`.
- **Rate limits come from `RATE_LIMIT_POLICIES`** (`src/core/rate-limit/`); never write a number in a feature. Routes use `@RateLimit(name)` (IP-keyed anywhere, user-keyed only on `@RequirePermission` routes); custom limits call `RateLimiter.consume()` / `release()` / `peek()` / `enforce()` (failure-only: `consume()` before the attempt, `release()` on success). E2E suites that hit limited routes call `resetRateLimits(app)` in `beforeAll`, because the counters persist in `app_test`.
- **Mail goes through `MailService`** (`src/core/mail/`), never a transport of your own. It throws `MailUnavailableError` (a 503) on failure and logs only the template name; don't log the recipient yourself either.
- **Email challenges go through `ChallengeEngine`** (`src/modules/challenges/`). In one transaction: `findUserId()` (unlocked), lock the user row, call the engine, `claim()` on success; commit; then `throw outcome.error` if it refused, and `deliver()` mail last. Never throw inside the transaction for a wrong OTP: the counted attempt must commit (D38).
- **Passwords go through `PasswordHasher`** (`src/modules/auth/password-hasher.ts`): argon2id, never trimmed, checked by `@PasswordPolicy()` before hashing. Hash before opening a transaction (D40).
- **Tokens go through `TokenService`, cookies through `AuthCookies`** (`src/modules/auth/`). Sign the pair before setting any cookie, so a failure sends no `Set-Cookie`. Never put a token in a body, header or URL. Protected routes get the user id from `request.authUserId`, set by the access check; never trust roles or ids from the token, body or query.
- **RBAC changes go through `RbacAdminService.change()`** (lock `rbac_policy_state`, change, check that an active `rbac@manage` holder remains, bump the version). A direct SQL change to RBAC tables must bump `rbac_policy_state.version` in the same transaction, or instances keep their old snapshot. In handlers, take the actor from `@CurrentUserId()`, never from the body.
- **E2E and RBAC:** call `ensureBootstrapped(app)` (`test/utils/rbac.ts`) and create users with `actorWithRoles()`; never assume you hold the only admin. Only the bootstrap suite wipes RBAC tables.
- **Permission before lookup:** a protected handler never reads the target resource before RBAC allows it, so the answer is `403`, not `404`. For a target that may belong to someone else, call `Ownership.selfOr(actor, target, permission, '<action>_any', operation)` **before** the lookup, and `Ownership.assertOwner()` after loading an owned resource (D48). Don't log the target id before those pass, and don't log request paths: the request log already has the route pattern (D49).
- **User reads (C12, D51):** keep the shared guard before ID/query validation and case-insensitive UUID ownership (explicit author choices). Valid non-UUID IDs become absent targets by binding `null`, never by casting arbitrary request text to UUID. Reuse `safeProfile()` for every profile response. List SQL uses a transaction-local `statement_timeout`, immutable keyset fields, and no OFFSET/count.
- **Storage (C13, D53):** consumers inject `ObjectStorage`, never filesystem paths. S3 prepends a private configured prefix; local storage rejects traversal/symlinks and is disabled in production. Generate keys from 16 cryptographically random bytes encoded as hex (128 random bits), never UUIDs, user ids or filenames (D55). Stream errors are sanitized before Fastify sees them. Uploads hold the shared adoption advisory lock; orphan reconciliation takes it exclusively. Never point an enabled reconciler at a temporary/unrelated DB paired with a persistent bucket: disable `STORAGE_WORKERS_ENABLED` for isolated live smoke tests.
- **Updates (C13, D52):** reuse `patchFields`/`normalizePatch` and the safe projector. Only actual field changes update timestamps. Direct email/status need `update_any` even for self. Status changes take the policy lock before user lock and blocking uses `assertRbacManagerRemains()` from the shared invariant. Email quota uses `RateLimiter.consume(..., manager)` so reservation/challenge commit or roll back together. Keep the savepoint around claim + email update: unique conflicts must commit `email_conflict`, while wrong OTP counts must also commit.
- **Photo failures:** compensate an uploaded object only after locking the target in a new transaction, then checking references; an unlocked read could miss an in-flight COMMIT. If the DB cannot decide, defer to reconciliation. Keep image signature/MIME/decoder checks, input-pixel bounds and explicit APNG rejection: libvips can expose only an APNG's default frame (D54).

## Gotchas

- **Fastify, not Express.** Use `FastifyRequest` and `FastifyReply` types, and `app.register(...)` plugins. `@Res()` without `passthrough: true` bypasses Nest's response handling.
- **`configureApp()` (`src/core/app/configure-app.ts`) is shared by `main.ts` and `test/utils/create-test-app.ts`.** Add app-wide setup there, not in `main.ts`, or e2e tests stop matching production.
- **Request ids come from Fastify's `genReqId`** (`src/core/logging/request-id.ts`). pino-http reuses `req.raw.id`; the `onSend` hook echoes `X-Request-Id`.
- **Readiness (`/health/ready`) is IP-gated** to `READINESS_ALLOWED_IPS` (loopback by default) and gives `404` to everyone else. Liveness (`/health/live`) touches nothing. The Dockerfile `HEALTHCHECK` and the CI smoke test use these paths; rename them together.
- **New readiness checks:** inject `ReadinessRegistry` (global) and call `register(name, check)` in `onModuleInit`. Pass `{ critical: false }` for a dependency only some requests need (SMTP): it is reported but doesn't fail readiness. Zero critical checks counts as not ready.
- **Jest needs the alias mapper** (`moduleNameMapper` in `package.json` and `test/jest-e2e.json`). New path aliases must be added in both and in `tsconfig.json`.
- **Migrations glob** is `src/database/migrations/*-*.{ts|js}` (only the current build's extension, because `dist/` also has `.d.ts`). Keep the CLI's `<timestamp>-<Name>` file naming.
- **Entities** are `*.entity.ts` anywhere under `src/` (loaded by glob). Give every constraint and index an explicit name (`pk_`, `uq_`, `fk_`, `ck_`, `idx_` + table), because tests and the error filter match on names. Use relative imports inside entity files: the TypeORM CLI doesn't resolve `@/`.
- **Generated migrations need a hand pass.** `migration:generate` emits a shared enum type (`challenge_method`, …) once per table that uses it, so the raw output fails on the second `CREATE TYPE`. Tidy the file, then prove it with `migration:run`, `migration:check`, `migration:revert`, `migration:run`.
- **Timestamps are `timestamptz(3)`**: declare them with `timestamp()` / `timestampNow()` from `src/database/columns.ts`, never `@UpdateDateColumn` (D12). Set `updated_at = now()` in the write itself.
- **Log-leak checks:** in an e2e file, create the app with `createTestApp({ logs: new LogCapture() })` once in `beforeAll`, and call `logs.expectNoLeaks(config, [values the test sent])` (D22). nestjs-pino keeps the first app's root logger for the whole file, so a second app's lines land in the first app's capture: with several apps in one file, share one file-level `LogCapture`, or a later suite's checks see nothing. Test-only routes go in `test/utils/*-probe.module.ts`, passed via `imports`.
- **Per-app config in e2e:** `createTestApp({ env: { SMTP_PORT: '1' } })`. Don't change `process.env` between apps in one file: Nest's ConfigModule reads it once per process. Read test mail with `test/utils/mailpit.ts` (`waitForMail(address)`), using a fresh address per test.
- **E2E shares one persistent database** (`app_test`, which must be named `*_test` or the helpers refuse to connect). Rows other suites commit stay there, so use unique values (random or suite-specific domains) and never assert on global state such as the RBAC version.
- **Graceful shutdown:** keep `enableShutdownHooks()` (in `configureApp`), and keep the Dockerfile running `node dist/main.js` under `tini`. npm doesn't forward SIGTERM.
- **The husky pre-push hook runs typecheck and unit tests**; it fails if no `.spec.ts` exists.

## Where things live

- `docs/roadmap.md`: the checkpoints (C0–C20) with their status, the gate each must pass, and the **working agreement** (how a checkpoint is built, reviewed and handed over). **Start here when picking up work**: check `gh pr list --state open` first, then take the first `⏭ next` row. Update the status table when a checkpoint lands.
- `docs/specs/`: the assignment, verbatim, one file per lesson.
- `docs/schema.md`: every table, and which spec rule each constraint enforces.
- `docs/invariants.md`: shared rules (statuses, lock order, challenge semantics, error codes, safe profile, logging, keys, cookies).
- `docs/decisions.md`: why things are the way they are (D1, D2, …). Add an entry for every non-obvious choice.
- `docs/known-gaps.md`: what's deliberately not done yet. Check it first and update it as gaps close.
- `src/core/`: config, database, logging, errors, rate limits, mail, authorization (route declarations, the global guard), health (the readiness registry) and app bootstrap.
- `src/modules/`: feature modules.
