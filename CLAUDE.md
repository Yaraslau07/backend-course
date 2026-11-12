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
npm run test:e2e            # needs `docker compose up -d`; uses .env.test and the app_test DB
npm run migration:generate  # needs a reachable DB; writes src/database/migrations/<ts>-Migration.ts
npm run migration:run
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
- **Permission before lookup:** a protected handler never reads the target resource before RBAC allows it, so the answer is `403`, not `404`.

## Gotchas

- **Fastify, not Express.** Use `FastifyRequest` and `FastifyReply` types, and `app.register(...)` plugins. `@Res()` without `passthrough: true` bypasses Nest's response handling.
- **`configureApp()` (`src/core/app/configure-app.ts`) is shared by `main.ts` and `test/utils/create-test-app.ts`.** Add app-wide setup there, not in `main.ts`, or e2e tests stop matching production.
- **Request ids come from Fastify's `genReqId`** (`src/core/logging/request-id.ts`). pino-http reuses `req.raw.id`; the `onSend` hook echoes `X-Request-Id`.
- **Readiness (`/health/ready`) is IP-gated** to `READINESS_ALLOWED_IPS` (loopback by default) and gives `404` to everyone else. Liveness (`/health/live`) touches nothing. The Dockerfile `HEALTHCHECK` and the CI smoke test use these paths; rename them together.
- **New readiness checks:** inject `ReadinessRegistry` (global) and call `register(name, check)` in `onModuleInit`. Zero registered checks counts as not ready.
- **Jest needs the alias mapper** (`moduleNameMapper` in `package.json` and `test/jest-e2e.json`). New path aliases must be added in both and in `tsconfig.json`.
- **Migrations glob** is `src/database/migrations/*-*.{ts|js}` (only the current build's extension, because `dist/` also has `.d.ts`). Keep the CLI's `<timestamp>-<Name>` file naming.
- **Graceful shutdown:** keep `enableShutdownHooks()` (in `configureApp`), and keep the Dockerfile running `node dist/main.js` under `tini`. npm doesn't forward SIGTERM.
- **The husky pre-push hook runs typecheck and unit tests**; it fails if no `.spec.ts` exists.

## Where things live

- `docs/specs/`: the assignment, verbatim, one file per lesson.
- `docs/invariants.md`: shared rules (statuses, lock order, challenge semantics, error codes, safe profile, logging, keys, cookies).
- `docs/decisions.md`: why things are the way they are (D1, D2, …). Add an entry for every non-obvious choice.
- `docs/known-gaps.md`: what's deliberately not done yet. Check it first and update it as gaps close.
- `src/core/`: config, database, logging, health (the readiness registry) and app bootstrap.
- `src/modules/`: feature modules.
