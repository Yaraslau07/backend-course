# Decisions

Short records of *why*. Add new entries at the bottom; don't rewrite old ones, add a superseding entry instead.

## D1: Stay on Fastify (2026-11-12)
The course boilerplate is Fastify and its README asks to keep it. Express-only packages from `touch-grass-back` are replaced: `helmet` becomes `@fastify/helmet`, `cookie-parser` becomes `@fastify/cookie`, and multer will become `@fastify/multipart`. Swagger UI on Fastify needs `@fastify/static`.

## D2: npm, Node 22 (2026-11-12)
The boilerplate ships `package-lock.json`, so CI, the Dockerfile and the hooks are npm-based. Node 22 LTS is pinned in `.nvmrc`, the Dockerfile and CI. `engines` says `>=22` so newer local Nodes still work.

## D3: TypeORM 0.3 with explicit transactions; `typeorm-transactional` removed (2026-11-12)
The spec depends on strict lock order (policy state → user → challenge → job), `SELECT … FOR UPDATE` and savepoints (email-change conflict). An ambient `@Transactional()` hides where a transaction starts and which locks it holds, so every transaction is written as `dataSource.transaction(async (manager) => …)`. That's easy to review and to explain.

## D4: One `validate()` for config, all keys defined up front (2026-11-12)
`validate()` (Joi schema plus cross-field rules) is the only way config enters the app. `main.ts` also calls it, because the Fastify adapter needs `TRUST_PROXY` before Nest exists. Every secret the spec mentions is required from Phase 0, so later phases never touch config plumbing, `.env.example` or CI env.
- Keys are base64url and must decode to ≥ 32 bytes. Length is measured on bytes, not characters.
- All keys must be different (compared by decoded bytes). Errors name the variables, never the values.
- The app never generates keys itself (the spec forbids per-launch random keys). `npm run keys:generate` prints a block to paste.

## D5: `COOKIE_SECURE=false` only outside production (2026-11-12)
Some HTTP clients don't send `Secure` cookies back over `http://localhost`. Validation rejects `COOKIE_SECURE=false` when `NODE_ENV=production`, which keeps the spec's "no exception for production" rule.

## D6: Liveness public, readiness internal by IP (2026-11-12)
`/health/live` touches no dependency, so a DB outage never restarts the container, and it's what the Docker HEALTHCHECK uses. `/health/ready` aggregates registered checks (`ReadinessRegistry`). It answers only to `READINESS_ALLOWED_IPS` (default loopback) and gives `404` to everyone else, so it looks like it doesn't exist. A separate internal port would be stronger but needs a second HTTP server; revisit if the app sits behind a real load balancer.

## D7: No response compression (2026-11-12)
`@fastify/compress` was removed. Responses are small JSON, and compressing responses that mix secrets with attacker-influenced content invites BREACH-style attacks.

## D8: nestjs-pino with path-only request logging (2026-11-12)
JSON logs carry a request id from Fastify's `genReqId`. An incoming `X-Request-Id` is reused only if it's a UUID; the id is echoed back in the response. Requests log only `method` and `path` (the query string is dropped: it can hold `q` and cursors). Cookie, authorization and set-cookie headers are redacted as a safety net.

## D9: Mail via SMTP (nodemailer) with Mailpit locally (2026-11-12)
The spec says SMTP. Mailpit in docker-compose catches all mail and exposes an API that e2e tests can read OTPs from. SMTP env vars exist from Phase 0; the MailService lands in Phase 1.

## D10: E2E against docker-compose Postgres, `.env.test` committed (2026-11-12)
A separate `app_test` database is created by `docker/postgres/init.sql`. `.env.test` holds **test-only** keys and is committed so `npm run test:e2e` works after cloning. CI overrides only the DB host and port.

## D11: Throttler wiring deferred (2026-11-12)
The boilerplate's single global limit (10 requests per 10 s) doesn't match the spec, which needs per-route, per-IP, per-email+IP and per-user limits. `@nestjs/throttler` stays installed, and the limits arrive with the routes that need them (Phase 1).

## D12: Timestamps are `timestamptz(3)`, written by the database (2026-11-16)
Postgres keeps microseconds, a JS `Date` keeps milliseconds. With the default precision, a `created_at` read into the app and sent back in a keyset cursor (specs 1.7, 2.3) would no longer equal the stored value, and rows could be skipped or repeated at a page boundary. Storing milliseconds makes the round trip exact. Every timestamp defaults to `now()`, so the clock is always the database's (spec 1.7). `updated_at` is set explicitly in each write instead of through `@UpdateDateColumn` or a trigger, because a no-op PATCH must not change it (spec 1.5).

## D13: Four challenge tables, one shared column set (2026-11-16)
Registration, login, email change and deletion each get their own table, built from one abstract `ChallengeBase`. The specs name them separately, each has its own HMAC key, and "one outstanding challenge per user" is per scenario, which a partial unique index on `(user_id) WHERE consumed_at IS NULL` gives directly. A single table with a `scenario` column would need that column in every index and query, and the email-change target address would be a nullable column used by one scenario.

## D14: The database enforces the rules a race could break (2026-11-16)
Service code checks first, but two concurrent requests can both pass a check. So the rules the specs call out are also constraints: unique email, the deleted-state CHECK, one outstanding challenge, one deletion job per user, unique tombstone, one grant per role and permission. `grant_actions` repeats `permission_id` so two composite foreign keys can guarantee that a listed action belongs to the grant's own permission, and that an action some grant lists can't be removed (the `409` in spec 1.1). Every constraint has an explicit name, so the error filter can turn a violation into the right status without parsing messages.

## D15: Ids are random UUIDs from `gen_random_uuid()`; a deletion job's id is the client's key (2026-11-16)
`gen_random_uuid()` is built into Postgres 13+, so no extension is needed (`uuidExtension: 'pgcrypto'`, `installExtensions: false`). Random (v4) rather than time-ordered ids, because ids appear in URLs and shouldn't reveal creation order or be guessable. `deletion_jobs.id` is `text` holding the 32 lowercase hex characters of `Idempotency-Key` exactly as sent (spec 1.6): the key is the receipt, and storing it as `uuid` would hand it back with dashes.

## D16: Entity files are excluded from unit coverage (2026-11-16)
An entity is a declaration, and its decorators' arrow functions (`() => 'now()'`) count as uncovered functions unless a unit test imports the file, which would test nothing. Unit tests have no database in CI. The schema is tested where it can fail: `test/schema.e2e-spec.ts` runs every constraint against real Postgres, and `npm run migration:check` fails CI when entities and migrations drift apart.

## D17: `npm run test:e2e` migrates the test database itself (2026-11-16)
Jest's `globalSetup` applies pending migrations to `app_test` before any suite, so e2e works on a fresh clone and after pulling a new migration. CI still runs `migration:run` explicitly first, because it also needs the drift check and the revert/re-apply check to run against a migrated database.
