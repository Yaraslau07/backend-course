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

## D18: One error filter, fixed messages, codes that fix the status (2026-11-16)
Every error leaves through `AllExceptionsFilter` as `{ statusCode, code, message, requestId }`. The message is the catalogue text for the code, never the exception's own: Nest's not-found message repeats the path and query, class-validator messages can include the submitted value, and Postgres quotes the offending input. Application code throws `AppException(code, extras)`, and the code decides the status, so `permission_denied` can never come back as a 400. Extras are a closed type (`ErrorExtras`), so nothing unplanned reaches a body. Validation errors list field paths and rule names (`{ field: 'email', rules: ['isEmail'] }`): enough to fix the request, nothing echoed.

## D19: Errors are logged by type, code and stack frames, never by message (2026-11-16)
The filter logs 5xx at `error` and an unhandled unique violation at `warn` (4xx are already in pino-http's request line). A log entry carries `requestId`, `statusCode`, `errorCode`, `errorType`, the SQLSTATE (`dbCode`), the constraint name, and the stack with its first line (the message) removed. Error messages and TypeORM's `parameters` are never logged, since both can hold user input. The field is `errorCode`, not `code`, because the logger redacts `*.code` (an OTP elsewhere). Debugging an unexpected error means reproducing it, which is the price of never logging a value.

## D20: Database trouble is a 503, a unique violation a 409 (2026-11-16)
Specs 1.2–1.7 all say "database unavailable → 503", and spec 1.7 says a statement over its 2 s timeout is a 503 too. `classifyDbError()` maps connection errors (SQLSTATE class 08, socket errors, pg-pool's connect timeout), resource and shutdown states (53, 57P0x), statement timeouts (57014) and serialization failures or deadlocks (40001, 40P01) to `503 service_unavailable`; in each case the transaction was rolled back and a retry may succeed. A unique violation that no feature caught becomes `409 conflict`, so a race never turns into a 500. Features still catch it themselves when the spec names a specific outcome.

## D21: Our own JSON body parser (2026-11-16)
Nest wraps any Fastify error that has a `statusCode` into an anonymous `HttpException`, so a malformed JSON body would arrive at the filter as a bare 400 with Fastify's message. `configureApp()` registers Fastify's own JSON parser (prototype-poisoning protection on) through `app.useBodyParser()`, but fails with `AppException('invalid_json')`. Registering it there also keeps Nest from installing its default parser at `init()`. The body limit stays 1 MiB.

## D22: E2E tests capture logs and check them for leaks (2026-11-16)
`LogCapture` (`test/utils/log-capture.ts`) replaces the log destination through the `LOG_SINK` provider and records every line at `debug`. `expectNoLeaks(config, values)` fails if any config secret, or any value the test sent (email, password, code, body), appears anywhere in the logs, and its failure message doesn't print the secret. nestjs-pino keeps one root logger per process, so a file creates its capturing app once, in `beforeAll`. Test-only routes live in `test/utils/*-probe.module.ts` and are passed to `createTestApp({ imports })`, so production code has no test hooks.

## D23: Four kinds of route declaration, resolved once per handler (2026-11-16)
Spec 1.3 names three: public, one `permission@action` pair, and a receipt (optionally with one pair). Readiness is a fourth case the spec describes separately ("only internal infrastructure"), so it gets `@Internal()`: the guard lets it through and the handler applies its IP gate. Treating it as `@Public()` would be wrong on paper, and leaving it undeclared would fail the scan. Decorators append to a list instead of overwriting, so `@Public()` plus `@RequirePermission()` is visible as a conflict rather than one silently winning. Names are normalized and checked with the RBAC pattern, so a typo in a permission name fails at startup, not at the first request.

## D24: Misdeclared routes fail twice: readiness and the request (2026-11-16)
The startup scan (`RouteDeclarationScanner`) logs every invalid route and keeps the `route_declarations` readiness check down, so an orchestrator never sends traffic to such a build. The guard independently answers `503 authorization_unavailable` without running the handler, for the case where traffic arrives anyway (spec 1.3: "if the request does reach the process"). The scan is static: declarations can't change at runtime, so it runs once.

## D25: Protected routes fail closed until the chain exists (2026-11-16)
Until C11 wires access → active user → CSRF → RBAC, the guard answers every protected route (and a receipt route called without its header) with `503 authorization_unavailable` and logs `category: authorization_chain`. A feature built before C11 can't accidentally be reachable without a permission check. The alternative, letting them through with a TODO, is exactly the bug the spec's "fails closed" rule exists to prevent.

## D26: A receipt-only route without its header is a 401 (2026-11-16)
The spec defines a receipt route without the header only when it also has a pair ("the request follows the usual chain"). With no pair there is no other way to identify the caller, which is what `401 invalid_session` means. The one receipt route in the specs (`GET /users/{id}/deletion-status`) has a pair, so this only decides what a future misuse looks like.

## D27: CSRF by Origin and a custom header, with no token (2026-11-16)
Specs 1.2 and 1.3 define the check: a write from another origin needs that exact origin in `CORS_ORIGINS` and `X-CSRF-Protection: 1`, even when the origins are same-site. The header works because a browser can't add a custom header to a cross-origin request without a CORS preflight, which only listed origins pass. With `SameSite=Strict` cookies on top, no CSRF token is needed. How the edge cases are decided:
- **Same-origin:** an `Origin` equal to the API's own (from `PUBLIC_API_BASE_URL`) passes without the header, which is the default deployment in the spec.
- **No `Origin`:** the request comes from an HTTP client or curl, so it passes. Browsers send `Origin` on every cross-origin write. The exception is a browser that marks the request `Sec-Fetch-Site: cross-site` or `same-site` without an origin; it is refused.
- **Exact match only:** `null`, a value with a path, a trailing dot or a second `Origin` header is refused. Matching is on the exact canonical origin a browser sends, never on a parsed or relaxed form.
- **Logs:** a rejection logs `reason` and the handler, never the origin, because the origin is attacker-chosen text.

## D28: Where CSRF runs in the chain (2026-11-16)
Public and internal writes (login, registration, refresh, logout) are checked in the route guard, since they have no session step. A receipt route with its header is checked there too. Protected routes are checked **after** the session and active-user steps, which spec 1.3 orders as access → user → CSRF → RBAC: an unauthenticated cross-origin write is a `401`, not a `403`. That position is wired in C11, so today a protected write is still the fail-closed `503`.

## D29: Rate limits are our own sliding windows in Postgres; `@nestjs/throttler` removed (2026-11-16, supersedes D11)
The specs state limits as "no more than N per window" (30 logins per IP per minute, 5 failed checks per email and IP in 15 minutes, …). They also assume several instances (RBAC version checks on every request, DB-leased jobs, local file storage only for a single dev instance) and name no shared store other than Postgres. So the counters live in Postgres (table `rate_limits`), shared by all instances and kept across restarts.
- **Exact sliding window.** Each row holds the timestamps of the allowed hits still inside the window. A fixed window would let 2N requests through around a boundary, which breaks "no more than N per minute".
- **One statement per check.** Pruning, the limit check and the append happen in one `INSERT … ON CONFLICT DO UPDATE`, so the row lock serializes concurrent requests and exactly N get through (tested with 50 at once).
- **Refused requests aren't counted**, so a client that backs off gets its budget back on schedule.
- **Why not `@nestjs/throttler`:** its named throttlers apply to every route unless skipped, and its guard runs outside our route guard. It also can't express "count only failures" or "count emails sent". The parts we would keep (a storage interface) are less code to write than to adapt.

## D30: Registration resend shares the registration threshold (2026-11-16)
Spec 1.0 asks for a rate limit on "registration and resending" but gives one configured number (`REGISTRATION_RATE_LIMIT_PER_HOUR`). Both use it, in separate buckets (`registration_ip`, `registration_resend_ip`), so resending doesn't eat the registration budget. The per-challenge 60 s cooldown still applies on top.

## D31: Counter keys are HMACs, under their own key (2026-11-16)
A key like `email + IP` would put PII in a table, and a plain SHA-256 of an IPv4 address can be reversed by trying all 2³² of them. So the stored key is `HMAC-SHA256(RATE_LIMIT_KEY_HMAC_KEY, policy + parts)`. The key is new and separate: `LOG_PSEUDONYM_HMAC_KEY` is documented as used for nothing else, and the specs require every key to be distinct.

## D32: How the different kinds of limit are applied (2026-11-16)
All policies are in one table (`RATE_LIMIT_POLICIES`, each citing its spec section), so no feature invents a number.
- **IP-keyed policies** are declared on routes (`@RateLimit('login_ip')`) and checked by the route guard after CSRF. A refused cross-origin write therefore doesn't use up the real client's budget. The IP is `request.ip`, which follows `TRUST_PROXY`.
- **User-keyed policies** need a signed-in user, so they are only valid on `@RequirePermission` routes. Elsewhere the route is invalid (`user_limit_without_session`). The guard applies them in the protected chain from C11.
- **Custom policies** are applied in code where only the handler knows the key or the moment:
  - login failures per email and IP: `peek()` before the password check, `record()` on failure;
  - emails sent per user: `consume()` before sending;
  - own vs. someone else's profile: decided after comparing ids.

  `peek()`/`record()` can let a few extra failures through when several arrive at the same instant. That is accepted, because the alternative (reserving a slot before checking the password) would count successes too.

## D33: Mail is sent inside the request, with a hard 2 s limit (2026-11-16)
Every challenge flow commits first, then sends, and must answer `503` with the challenge kept when SMTP fails (specs 1.0, 1.2, 1.5, 1.6). So the send happens inside the request, and it has to fail fast. `MailService` bounds the whole send to `MAIL_TIMEOUT_MS` (2 s): nodemailer's own connection, greeting and socket timeouts, plus an outer timer for anything they don't cover. A failure throws `MailUnavailableError`, an `AppException('service_unavailable')`, so an uncaught one is already a correct 503. Flows catch it to add `confirmationRequired`, `method`, the challenge id and `retryAfterSeconds`. If the outer timer fires while the server is still accepting, the mail may arrive after we answered 503. That is harmless: the challenge was kept, and resend replaces the secret.

## D34: What mail code may log, and how the transport is locked down (2026-11-16)
A mail log line carries the template name (`login_otp`, …), the outcome, a failure category (our `timeout`, or the transport's code such as `ECONNECTION` or `EAUTH`) and the duration. Never the recipient, subject, body or transport message: SMTP errors quote addresses and server responses (`550 <user@…> unknown`). nodemailer's own logger is off, and file and URL access are disabled, since messages only come from our templates. In production STARTTLS is required unless `SMTP_SECURE` is on, so a code never crosses the network in clear text. Readiness has an `smtp` check (`verify()`), so a misconfigured server is visible before the first registration fails.

## D35: Magic links point at frontend pages, with the token in the fragment (2026-11-16)
A link is `FRONTEND_URL + <path> + #token=<token>`, with one path per scenario (`/auth/register/confirm`, `/auth/login/confirm`, `/account/email/confirm`, `/account/deletion/confirm`). The fragment is never sent to any server, so the token can't land in access logs, proxies or a `Referer` header. Opening the page changes nothing; it POSTs the token to the API (specs 1.0, 1.2). There is no frontend in this project, so the paths are the contract a frontend would implement. In an HTTP client you copy the token from the mail in Mailpit.

## D36: nodemailer 10.3.1, pinned (2026-11-16)
The latest release (10.6.0) was a day old when this was written. 10.3.1 is the newest one that had been out for two weeks, a buffer against a compromised or broken release. It ships its own types, so there is no `@types/nodemailer`. Upgrade deliberately, not through a caret range.
