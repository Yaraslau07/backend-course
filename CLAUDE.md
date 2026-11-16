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
- **Secrets are base64url, ≥ 32 decoded bytes, and all different.** A new secret also goes into `SECRET_KEY_NAMES` and `scripts/generate-keys.mjs`. Never put a real key in a committed file. `.env.test` keys are test-only.
- **Never log** the values listed under "Logging" in `docs/invariants.md`: emails, passwords, secrets, tokens, cookies, full URLs and query strings, bodies, headers, storage keys. Log ids, categories and counts.
- **Errors go through `AppException(code, extras?)`** (`src/core/errors/`). The code fixes the status and the message; a new code goes into `ERROR_CATALOGUE`, a new extra into `ErrorExtras`. Never put a request value, a library message or a constraint name into a response (D18).
- **Every route needs an access declaration** (`src/core/authorization/route-access.ts`): `@Public()`, `@Internal()`, one `@RequirePermission(permission, action)`, or `@Receipt(header)` with at most one pair. Without one, readiness fails and the route answers 503. Test-only probe routes need one too.
- **CSRF is in the guard** (`src/core/authorization/csrf.ts`), never in a handler. Don't add a second check, and don't skip it for "safe" writes; if a write must be callable cross-origin, its origin goes into `CORS_ORIGINS`.
- **Rate limits come from `RATE_LIMIT_POLICIES`** (`src/core/rate-limit/`); never write a number in a feature. Routes use `@RateLimit(name)` (IP-keyed anywhere, user-keyed only on `@RequirePermission` routes); custom limits call `RateLimiter.consume()` / `release()` / `peek()` / `enforce()` (failure-only: `consume()` before the attempt, `release()` on success). E2E suites that hit limited routes call `resetRateLimits(app)` in `beforeAll`, because the counters persist in `app_test`.
- **Mail goes through `MailService`** (`src/core/mail/`), never a transport of your own. It throws `MailUnavailableError` (a 503) on failure and logs only the template name; don't log the recipient yourself either.
- **Email challenges go through `ChallengeEngine`** (`src/modules/challenges/`). In one transaction: `findUserId()` (unlocked), lock the user row, call the engine, `claim()` on success; commit; then `throw outcome.error` if it refused, and `deliver()` mail last. Never throw inside the transaction for a wrong OTP: the counted attempt must commit (D38).
- **Passwords go through `PasswordHasher`** (`src/modules/auth/password-hasher.ts`): argon2id, never trimmed, checked by `@PasswordPolicy()` before hashing. Hash before opening a transaction (D40).
- **Permission before lookup:** a protected handler never reads the target resource before RBAC allows it, so the answer is `403`, not `404`.

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
- **Log-leak checks:** in an e2e file, create the app with `createTestApp({ logs: new LogCapture() })` once in `beforeAll`, and call `logs.expectNoLeaks(config, [values the test sent])` (D22). Test-only routes go in `test/utils/*-probe.module.ts`, passed via `imports`.
- **Per-app config in e2e:** `createTestApp({ env: { SMTP_PORT: '1' } })`. Don't change `process.env` between apps in one file: Nest's ConfigModule reads it once per process. Read test mail with `test/utils/mailpit.ts` (`waitForMail(address)`), using a fresh address per test.
- **E2E shares one persistent database** (`app_test`, which must be named `*_test` or the helpers refuse to connect). Rows other suites commit stay there, so use unique values (random or suite-specific domains) and never assert on global state such as the RBAC version.
- **Graceful shutdown:** keep `enableShutdownHooks()` (in `configureApp`), and keep the Dockerfile running `node dist/main.js` under `tini`. npm doesn't forward SIGTERM.
- **The husky pre-push hook runs typecheck and unit tests**; it fails if no `.spec.ts` exists.

## Where things live

- `docs/roadmap.md`: the build order (phases, what's done, what's next, what can run in parallel). **Start here when picking up work**, and update its status table when a phase lands.
- `docs/specs/`: the assignment, verbatim, one file per lesson.
- `docs/schema.md`: every table, and which spec rule each constraint enforces.
- `docs/invariants.md`: shared rules (statuses, lock order, challenge semantics, error codes, safe profile, logging, keys, cookies).
- `docs/decisions.md`: why things are the way they are (D1, D2, …). Add an entry for every non-obvious choice.
- `docs/known-gaps.md`: what's deliberately not done yet. Check it first and update it as gaps close.
- `src/core/`: config, database, logging, errors, rate limits, mail, authorization (route declarations, the global guard), health (the readiness registry) and app bootstrap.
- `src/modules/`: feature modules.
