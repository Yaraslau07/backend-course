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
