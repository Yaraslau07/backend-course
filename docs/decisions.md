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

## D37: Phase 1b review fixes (2026-11-16, amends D18, D21, D24, D32, D34)
From the `/code-review` of C2–C6:
- **Failure-only limits reserve, then release** (amends D32). `peek()` then `record()` let 50 concurrent wrong passwords all reach the password check. Now `consume()` takes a slot atomically *before* the check, and `release()` gives it back on success. At most 5 checks per email and IP can be in flight or failed within 15 minutes; `record()` is gone.
- **SMTP is a non-critical readiness check** (amends D34). An SMTP outage marked every instance not ready, which would take logins, profiles and lists down with mail. Readiness checks can now be registered with `critical: false`: they are reported but don't change `status`. Only the challenge flows need SMTP, and they answer 503 themselves. The check result is also cached for 30 s, so probes don't open an SMTP connection each time.
- **A code always means one status** (amends D18). An HttpException with an unmapped 4xx used to keep its status but be called `bad_request`. Now 405, 408 and 422 have their own codes, and any other 4xx becomes a plain `400 bad_request`.
- **Form-encoded bodies are refused** (amends D21). Registering our JSON parser also stops Nest from installing its `application/x-www-form-urlencoded` parser, so such bodies get `415`. That is intended: this is a JSON API, and HTML forms are the classic CSRF vector.
- **The route scan follows inheritance** (amends D24). A handler inherited from a base controller is now scanned too, so it can't take traffic undeclared.
- **Counter rows:** `expires_at` is now always the newest stored hit plus the window (a refusal no longer pushes it), and `consume()` evaluates the live hits once.
- **Still open, by design:** IP- and user-keyed limits on protected routes are enforced only once the chain exists (C11); until then those routes refuse every request.

## D38: One challenge engine; refusals are returned, not thrown (2026-11-16)
`ChallengeEngine` (`src/modules/challenges/`) implements issue, resend, confirm and claim once, for all four scenarios. A scenario is only configuration: table, HMAC key, the response's id name (`attemptId` or `challengeId`), and whether the magic-link token carries the id.
- **Refusals are returned.** State-changing calls return an `Outcome` (`{ ok: true, value }` or `{ ok: false, error }`) instead of throwing. A wrong OTP must commit its counted attempt, and the 5th wrong one must commit the exhaustion, *and* answer 400. A thrown error would roll both back. The flow commits, then throws `outcome.error`, an `AppException` carrying the spec's code and a `reason` for logs and flow-specific answers.
- **The flow owns the transaction and the user lock.** `findUserId()` reads a challenge's owner without a lock. The flow then locks the user, and the engine locks the challenge (`FOR UPDATE`), giving the documented order user → challenge. Without the user lock, the partial unique index still refuses a second outstanding challenge (tested).
- **Confirm checks in the spec's order:** found and owned, then not consumed, then the right method, then not expired (no attempt counted), then the user still eligible, then the HMAC in constant time. On success nothing is consumed: the flow acts, then calls `claim()` with its own reason (`confirmed`, `email_conflict`, `job_exists`). `claim()` is the conditional `UPDATE … WHERE consumed_at IS NULL` (claim-then-act), so a challenge can be used once even if a lock were missed.
- **Time is the database's.** TTL and cooldown use `now() - last_sent_at` in SQL, so instances with skewed clocks agree.
- **Secrets:** OTPs come from `randomInt` (uniform 000000–999999); magic secrets are 32 random bytes. Both are stored only as `HMAC-SHA256(scenario key, "email-challenge:v1" ‖ scenario ‖ secret)`. Registration finds its challenge by that HMAC, the others by the id in `id.secret`.
- **Codes:** `invalid_challenge` (400) for not found, expired, wrong, replaced, confirmed or `user_inactive`; `attempts_exhausted` (429); `resend_cooldown` (429, with `retryAfterSeconds`); `challenge_conflict` (409) for `admin_override`, `email_conflict` and `job_exists`. A confirm by a user who is no longer eligible defaults to `401 invalid_session`; login turns it into `invalid_credentials` (C9).
- **Delivery:** `deliver()` sends after commit. A mail failure becomes the 503 the specs describe (`confirmationRequired`, `method`, the id, `retryAfterSeconds: 60`) and the challenge stays.

## D39: C7 review fixes (2026-11-16, amends D38)
- **Real time, not transaction time.** TTL, cooldown, `last_sent_at` and `consumed_at` use `clock_timestamp()`. `now()` is frozen at the transaction's start, so a request that waited for the user or challenge lock could accept a challenge that had expired in the meantime, or store a send time in the past.
- **Exactly 10 minutes is expired** (`age >= 600`): valid until `last_sent_at + 10 minutes`, not through it.
- **An ineligible user's confirm is `400 invalid_challenge`**, the same as resend and as spec 1.0 lists for registration. Flows with a session or a login answer remap `reason: 'user_inactive'`: login to `401 invalid_credentials` (spec 1.2), email change to `401 invalid_session` (spec 1.5), deletion to `401` (spec 1.6).
- **Exhaustion is logged as its own event** (`exhausted`); the client still gets the 400 the spec gives the 5th wrong code.
- **`newEmail` is checked:** required for an email change and refused elsewhere. Getting it wrong is a programming error, so it throws plainly.
- **Not changed:** without the user lock, two concurrent `issue()` calls for a user with no outstanding challenge both insert, and the partial unique index refuses the second. That error reaches the filter as `409 conflict` (D20), not a 500. Flows always take the user lock first, so they never see it.

## D40: Passwords: argon2id via `@node-rs/argon2`, an explicit maximum (2026-11-16)
- **Library:** `@node-rs/argon2` 2.2.2, pinned. It ships a prebuilt binary per platform as an optional dependency, including `linux-x64-musl` for the Alpine image, and has no install script, so `npm ci --ignore-scripts` in the Dockerfile still works. The `argon2` package needs a `node-gyp` install script.
- **Parameters:** argon2id, 19 MiB, 2 passes, 1 lane (the OWASP minimum), about 25 ms per hash here. The salt and parameters are in the stored string, so they can be raised later without a migration: old hashes still verify.
- **Policy (spec 1.0):** 8 to 128 characters, counted as code points so an emoji is one character, never trimmed or normalized. At least one letter of any alphabet (`\p{L}`) and one digit (`\p{Nd}`). Argon2 itself has no 72-byte cut like bcrypt, but unbounded input is unbounded work, so anything over 128 characters is rejected, never cut.
- **Hashing happens before the transaction,** so no row lock is held while it computes.

## D41: Registration flow choices (2026-11-16)
- **Explicit `409 email_taken`,** the spec's default, rather than its optional neutral answer. The unique index decides, so two concurrent registrations give one 201 and one 409.
- **Confirm is claim-then-act:** the challenge is claimed before the user becomes `active`, so a challenge used twice at once activates once. Only a `pending` user is eligible; anything else is a dead challenge (`400 invalid_challenge`).
- **Resend is by email (spec 1.0)**:
  - The outstanding challenge is resent under the same `attemptId`.
  - If the last challenge is used up (exhausted, replaced), a new one is issued instead, because registration has no other way to get a new mail. Its 60 s cooldown still counts from the last mail (the engine's `cooldownFromLatest`), so exhausting the attempts doesn't skip the wait.
  - The method is the one recorded with the registration, even if the setting has changed since.
  - An unknown email and a non-pending user both answer `400 invalid_challenge`.
- **Rate limits:** `registration_ip` on register and `registration_resend_ip` on resend (D30). Confirm has none: an OTP allows 5 tries per mail, and a magic token is 32 random bytes.
- **No role yet.** Spec 1.0: while RBAC isn't there, activation assigns no role; the RBAC bootstrap (C10) gives existing active users `user`, and from then on activation assigns it in the same transaction.

## D42: Tokens and cookies: HS256 on `node:crypto`, an explicit cross-site flag (2026-11-17)
- **No JWT library.** HS256 is one HMAC-SHA256 over `header.payload`, so `src/modules/auth/tokens/jwt.ts` does it with `node:crypto` in about 100 lines:
  - It signs and accepts exactly one header, `{"alg":"HS256","typ":"JWT"}`. Anything else (`none`, other algorithms, `kid`, `crit`) is `malformed`, so there is no algorithm negotiation to attack.
  - It compares the signature text in constant time, before the payload is parsed. Comparing text rather than decoded bytes also refuses non-canonical encodings.
  - Claims are checked exactly: `sub` must be a uuid, `iss` and `aud` must equal the configured values (no audience arrays), `iat` and `exp` must be integers with `exp > iat`, and `iat` may be at most 30 s in the future. A token counts as expired 30 s after `exp`.
  - The failure categories are the spec's own (`missing`, `malformed`, `signature`, `expired`, `claims`, `token_use`). With a library they would be mapped from its error types.
  - Why not a library: `jose` 6 is ESM-only, which Jest's CommonJS setup can't load (the same trap as `@fastify/static`, see `configure-app.ts`), and `jsonwebtoken` pulls in `jws` and several `lodash.*` packages to do the same HMAC. The code is covered by `jwt.spec.ts`, including tokens built independently of it, so it interoperates.
- **Access and refresh keep separate keys** (spec), so a refresh token sent as an access token fails on its signature before `token_use` is read. `token_use` is still checked.
- **`COOKIE_SAME_SITE=strict|none`** (default `strict`). Spec 1.2 wants `SameSite=None; Secure` when the frontend is on another site. "Another site" needs the registrable domain, which needs a public-suffix list (`github.io` is a suffix, for example). The operator knows this, so it is a flag. `none` is refused at boot unless `COOKIE_SECURE=true`, because browsers drop a `SameSite=None` cookie that isn't `Secure`. Chosen by the author on 2026-11-17.
- **Logout** sends both cookies empty, with `Max-Age=0`, `Expires` set to 1970, and the same `Path`, `HttpOnly`, `Secure` and `SameSite` they were set with, so the browser matches and drops exactly those cookies.
- **The refresh cookie is read from `Cookie` only.** A body, query or `Authorization` header is ignored (spec 1.2 §1.3.4); the route reads no body at all.

## D43: Login flow choices (2026-11-17, amends D25)
- **The failure limit (`login_failures`, 5 per email and IP per 15 min) counts every 401:** unknown email, wrong password and non-active status. Counting only known users would let the 429 reveal which emails exist. A slot is consumed before the argon2 check and released on success (D32), so a correct password doesn't use up the budget. When the limit is reached, even the right password gets `429` (the spec checks the limit before the expensive hash).
- **One verify per attempt:** an unknown email, and a `deleted` user (no hash), are checked against a dummy hash made at startup with the real parameters, so timing doesn't tell them apart.
- **The email step locks the user again** and re-checks `active` before issuing. The engine's `issue()` applies the 60 s cooldown to the outstanding challenge under that lock and replaces it after the cooldown. Only an outstanding challenge counts (no `cooldownFromLatest`, unlike registration): spec 1.2 says "previous incomplete challenge".
- **Confirm signs both tokens inside the transaction, before the claim.** If signing fails, the transaction rolls back and the same code can be tried again (spec 1.2 §1.3.2).
- **A user who stopped being `active` gets `401 invalid_credentials`** on confirm (spec 1.2 §1.3.2 step 4) and, by the same rule, on resend, where the spec is silent. Either way the challenge is consumed as `user_inactive`, so a later try gets `400`. Chosen by the author on 2026-11-17.
- **Confirm and resend have no IP rate limit** of their own, as in registration (D41): an OTP allows 5 tries per mail, and the mails themselves are limited by the 60 s cooldown and by the login limits.
- **The access check runs now (amends D25).** On a protected route the guard authenticates first: no cookie or a bad one gives `401 invalid_session`, and a user who can't be read gives `503 authorization_unavailable`. Then it still fails closed with 503 until C11 adds CSRF, user limits and RBAC. The verified id is put on `request.authUserId` for the chain. Chosen by the author on 2026-11-17.
- **pg `connectionTimeoutMillis` is 5 s,** so an unreachable database (dropped packets rather than a refused connection) gives a prompt 503 instead of waiting for the OS timeout. Closes the gap noted in C2.
