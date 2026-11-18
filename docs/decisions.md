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

## D44: C9 review fixes (2026-11-17, amends D43)
`/code-review medium main...HEAD` raised nine findings. `/security-review` found nothing at the reporting bar.

**Fixed:**
- **Only a decided 401 keeps the `login_failures` slot.** Before, the slot was given back only on success. So a database error, a timeout, or a cooldown `429` after a correct password still counted as a failed check, and could lock a real user out for 15 minutes during a database blip. Now any other outcome gives the slot back. A late `401` (the user was blocked between the password check and the lock) keeps it, as D43 says.
- **The access check answers 503 only for an outage.** It uses `classifyDbError(...).kind === 'unavailable'`. Any other error reaches the filter as a `500`, so a bug doesn't look like the database being down.
- **A deleted user (no hash) is logged as `user_inactive`,** not `wrong_password`.
- **A refusal by the failure limit is logged with the email pseudonym,** so attacks on one address can be matched (spec 1.2 §1.5).

**Not changed, and why:**
- **Core's guard imports `AccessAuthenticator` from the auth module.** C11 rebuilds the whole chain (access → CSRF → limits → RBAC) and decides where its pieces live. Moving the authenticator now would move it twice. `route-access.ts` already imports from `modules/rbac`.
- **Refresh and the access check each have their own "token → active user" code.** Spec 1.2 gives them different answers when the database is down (`503 authorization_unavailable` in the chain, a plain `503` on refresh), so a shared helper would need a flag. The shared part is three lines.
- **`LoginConfirmDto` copies `RegistrationConfirmDto`.** The two token formats already differ (registration's token has no id, D41), and email change and deletion will add their own fields. A shared DTO waits until C13 shows what is actually common.
- **`ACCESS_COOKIE` lives in `configure-app.ts`** because Swagger's cookie scheme there needs it. Moving it is cosmetic and can happen in C11 with the chain.

## D45: RBAC snapshot, bootstrap and default role (2026-11-17)
- **What the snapshot holds:** roles, permissions, their actions, and grants, which is everything except who has which role. It is read in one `REPEATABLE READ` transaction, so the version and the tables come from the same moment. It is checked for what the schema can't express (an all-actions grant lists nothing, a limited grant lists at least one action), and swapped in whole.
- **User roles are read per request** (`SELECT role_id FROM user_roles WHERE user_id = $1`, on the primary key). Caching them would make every registration and role change invalidate every instance's cache, and the cache would grow with the user count. The spec's coherence rule is about the cached policy. Admin `PUT …/roles` still bumps the version, as spec 1.1 §1.3.5 says.
- **Activation doesn't bump the version.** Assigning `user` on activation (`assignDefaultRole`, in the activating transaction, `ON CONFLICT DO NOTHING`) changes no cached data. Bumping would put every registration behind the shared `rbac_policy_state` lock, which must also be taken before the user row. Chosen by the author on 2026-11-17.
- **Version check before every access check;** on a mismatch the instance reloads. Concurrent requests share one reload. A request that joins a reload started before its own version read loads again if the result is older, so a request that starts after an admin change's response always sees that change. While a reload fails, there is no snapshot at all: `503 authorization_unavailable`, and the `rbac` readiness check is down, never an old policy (spec 1.1 §1.3.6 step 6).
- **An unknown permission or action is a 403** (no rule means no access), logged with its reason (`unknown_permission`, `unknown_action`, `no_grant`).
- **The bootstrap** runs at startup under the policy lock, so two instances starting together bootstrap once. "Empty" means no roles and no permissions. It needs `RBAC_BOOTSTRAP_ADMIN_USER_ID` to be an existing active user; otherwise it creates nothing, logs a warning, and runs again at the next start. Bootstrapping without an admin would leave a policy nobody can change through the API. Chosen by the author on 2026-11-17.
  - `admin` gets `rbac` with the listed action `manage`, and `users` with all actions, so later `users` actions reach admins automatically.
  - `user` gets `users` `read`, `update` and `delete`.
  - Every active user without a role gets `user`; pending users get it when they confirm.
- **Admin changes** all share one shape:
  1. Lock `rbac_policy_state` (first in the lock order).
  2. Make the change.
  3. Check that an active user can still do `rbac@manage`, on the state about to be committed. An all-actions grant counts only while the permission still has `manage`.
  4. Bump the version.
  
  Any refusal rolls everything back.
- **Error codes** (new): `409 name_taken` (`uq_roles_name`, `uq_permissions_name`), `409 grant_exists` (`uq_grants_role_permission`), `409 resource_in_use` (any foreign-key refusal: a role with grants or users, a granted permission, an action a grant lists explicitly) and `409 last_rbac_manager`. The constraints decide, not pre-checks, so concurrent changes can't slip past them.
- **404 for references in a body** (an unknown `roleId` or `permissionId` in a grant, an unknown role in a user's list), as spec 1.1 §1.4 lists "the role, permission, assignment, or user from the administrative operation". An action that isn't the permission's is `400 validation_failed` (`actionOfPermission`).

## D46: The protected chain runs RBAC now (2026-11-17, amends D25, D28, D43)
The author chose to wire RBAC in C10 so the admin API works over HTTP. A protected route now runs:
1. Access check: `401`, or `503` if the user can't be read.
2. CSRF on writes, after identity (D28).
3. The route's IP limits.
4. RBAC: `403 permission_denied`, or `503` without a current policy.
5. The handler.

What is still for C11: user-keyed rate limits, the resource and ownership step, and the full chain audit. Until then, a protected route that declares a user-keyed limit answers `503`; it doesn't run without its limit. No such route exists yet.

The verified user id goes to handlers through `@CurrentUserId()`, which fails closed (`503`) if the chain didn't set it.

## D47: C10 review fixes (2026-11-17, amends D45)
`/code-review medium main...HEAD` raised eight findings, and `/security-review` found nothing at the reporting bar.

**Fixed:**
- **Readiness loads the policy itself when there is no snapshot.** Before, only a protected request triggered the reload. An instance whose first load failed (the database not up yet) stayed not-ready forever, because a load balancer sends no traffic to a not-ready instance.
- **A failed bootstrap fails the load.** Before, a bootstrap error was only logged, and the empty policy was then loaded as if it were real: everyone got 403 and nobody could repair it. Now every load retries the bootstrap until it completes once.
- **The `user` role can't be renamed or deleted** (`409 resource_in_use`). Activation finds it by name, so a rename would silently give new users no role. Its description and grants can still change.
- **Reloads that finish out of order** no longer replace a newer snapshot with an older one. A failed reload clears the snapshot only if no newer one arrived in the meantime.
- **The user-limit fail-closed check runs before the IP limits,** so a request refused with 503 doesn't use up the client's IP budget.
- **The version check and the user-roles read run in parallel**, which saves one round trip per protected request.
- **The refusal log field is `errorCode`,** not `code`, which the logger redacts.
- **The e2e leak check** matches an all-digit secret (an OTP) only as a whole token. A 6-digit code also turns up by chance inside the UUIDs in the logs, and did once (`challenges.e2e-spec.ts`).

**Not changed:** an activation that commits while the bootstrap transaction is still open can miss both the default-role insert and the bootstrap's backfill. The bootstrap runs once, in `onApplicationBootstrap`, before this instance listens, so only a second instance taking registrations at that exact moment is exposed. Listed in `docs/known-gaps.md`.

## D48: The full authorization chain and the ownership step (2026-11-17, completes D46)
- **The chain**, in the order of spec 1.3 §1.3.1 and §1.6. Each step runs only if the previous one passed, and the handler only after all of them:
  1. Access JWT from the cookie only (`401 invalid_session` with a log category).
  2. The user is `active`, read by `id, status` (`401`, or `503` with category `users` if the read fails).
  3. CSRF on writes (`403 csrf_rejected`).
  4. The route's IP limits, then its user-keyed limits by the verified id (`429`).
  5. RBAC (`403 permission_denied`, or `503` with category `rbac_version` or `rbac_snapshot`).
  
  A request refused at any step uses up no later step's budget: a CSRF refusal counts against no limit, and a missing session counts against no user limit.
- **Limits sit before RBAC,** as D37 and the roadmap have it. A user who is going to be refused still uses up their own budget, which also caps probing for rights. They are counted per user id, so this hurts nobody else.
- **The ownership step is a service the handler calls** (`Ownership`, exported by `AuthorizationModule`). The guard can't run it, because only the handler knows the target.
  - `selfOr(actor, target, permission, anyAction)` runs **before the lookup** (spec 1.4 §1.3.1 steps 4–5). The caller's own id passes. Someone else's id needs the extra action (`users@read_any`, `update_any`, `delete_any`), or gets `403 ownership_denied`. So without the right, the answer is the same whether the target exists or not, and the target id isn't logged.
  - `assertOwner(actor, owner)` runs **after the load**, for resources that carry an owner (Part 2's transformations): `403 ownership_denied`.
  - A `404` is only possible once both checks pass.
- **`ownership_denied` for a missing `_any` action,** not `permission_denied`: the caller has the right to the resource type, just not to someone else's (docs/invariants.md, "allowed type, not your resource").
- **Every RBAC decision is logged** (`event: rbac_decision`) with `actorUserId`, the operation (`Controller.handler`), the pair, the policy version and the result. Allowed decisions are logged at `info` too. Spec 1.3 §1.5 asks for "successful admission to critical operations"; logging every admission avoids having to keep a list of which operations are critical, and the volume is small for this service.
- **The client-side refresh rules (spec 1.3 §1.3.3)** concern a frontend this project doesn't have. The server provides what they rely on: a guard `401 invalid_session` always comes before the handler starts, so a retry after a refresh is safe. A `403` or `503` never means "refresh".

## D49: Request logs name the route pattern, not the path (2026-11-17, amends D8)
D8 logged `method` and `path`, on the view that path segments are ids. Spec 1.3 §1.5 allows a target id in logs only once it may be read, and spec 1.6 forbids user ids in deletion logs. A path like `/users/{id}` is logged before either check, so it breaks both rules. The completion line now has `route`, the pattern Fastify matched (`/users/:userId`), or `null` for a URL that matched no route, since it could be anything. Handlers log the target id themselves once it is allowed.

pino-http binds the request serializer when the request starts, before the route is on the raw request. So the bound `req` carries only `id` and `method`, and `route` is added by `customSuccessObject` / `customErrorObject` when the request completes. The pattern is copied onto the raw request in `configureApp`'s `onRequest` hook.

## D50: C11 and phase 1c review fixes (2026-11-17, amends D48)
`/code-review medium` ran on `main...HEAD` (C11) and on `44ffd0a...HEAD` (all of phase 1c, C7–C11). `/security-review` on the phase range found nothing at the reporting bar.

**Fixed:**
- **Ownership compares ids case-insensitively.** `ParseUUIDPipe` accepts an uppercase uuid while token ids are lowercase, so a user's own id in uppercase came out as `foreign` and got `403 ownership_denied`.
- **One refusal, one category.** `RbacAuthorizer.allows()` (the ownership step's `_any` check) no longer logs. Before, a refused foreign request logged both `permission_denied` and `ownership_denied`.
- **User limits are counted before IP limits** (amends D48). A user past their own limit used to spend the IP budget that everyone behind the same address shares. Now an IP refusal costs only the requesting user's budget.
- **The test helpers bump the policy version only for a real change**, and `rbac.e2e-spec.ts` uses the shared probe setup instead of its own copy.
- The guard's class comment was stale; a redundant type cast and an import order were tidied.
- **One e2e test that couldn't fail was removed.** It claimed that an unauthenticated request doesn't count against a user limit, which holds by construction. The guard unit tests cover the real ordering: CSRF before limits, and limits before RBAC.

**Not changed:**
- **Reusing the guard's snapshot and roles in the ownership step.** It would save two queries on foreign requests, but it would make handlers depend on state the guard leaves on the request. Revisit if profiling shows it matters.
- **`request.routeOptions.url` building an object on each request.** This is a micro-optimisation.
- **Merging `allows()` into `decide()`.** They now differ (logging), so both are kept.

## D51: C12 safe profiles, protected photos and signed user listing (2026-11-17)

- **Two explicit author choices amend the literal ordering/comparison wording in spec 1.4.** The author chose “Keep C11: UUID case does not change ownership” and “Keep the shared guard order”. Authentication and base RBAC run before handler validation, and an uppercase spelling of the caller's UUID still counts as self. The assignment files remain verbatim. IDs accept ASCII letters/digits/underscore/hyphen, 1–128 characters; a valid non-UUID cannot match this schema and is queried as `id = NULL`, yielding 404 only after permission checks. This avoids a 500 from PostgreSQL's UUID cast without narrowing the HTTP ID contract.
- **One fixed projector (`safeProfile`).** Only seven allowed fields are copied, timestamps are UTC ISO strings, and the saved display name/email are returned unchanged. A photo URL names the protected API route; `deleting`/`deleted` and absent keys always produce null. Queries select only the fields needed by the profile/photo operation. The list never reads photo storage.
- **Scoped profile limits.** The handler chooses the existing self/foreign policy by the same UUID comparison as ownership, applies it before the extra `_any` check and resource lookup, and shares that budget between profile and photo reads. Base `users@read` was already checked by the guard. The list uses the guard's existing actor-before-IP policies. An actor with only `users@list` can list without being allowed to read individual profiles.
- **Query validation follows RBAC.** Unknown and repeated query parameters are rejected. Email prefixes are trimmed/lowercased; names are trimmed/NFC and compared using PostgreSQL `lower(normalize(..., NFC))`, with the query lowercased by the same database collation. `%`, `_` and backslash are escaped as literals. SQL identifiers/directions are chosen exclusively from server constants; values are bound parameters.
- **Keyset pagination.** `(created_at, id)` or `(id, created_at)` has one shared direction; a strict `created_at < snapshotAt` excludes boundary/later inserts. The first boundary comes from the database clock, truncated to the schema's millisecond precision. A page fetches `limit + 1` and signs the last returned row only when there is another row. Existing rows can change filter membership; no historical MVCC snapshot is promised. Four range indexes and two prefix indexes are reversible migrations, with TypeORM explicitly leaving the expression/opclass definitions to the migration.
- **Cursor format and rotation.** The JSON fields have a fixed emission order and only immutable ordering data. Signature and query tag use separate `users-list-cursor:` / `users-list-query:` HMAC domains. Decoding bounds size, requires canonical unpadded base64url, verifies signatures/tags in constant time, checks the exact field set, dates, UUID, version, query and fixed 15-minute interval. A continuation retains the first issued/expiry times and signs with the current active key. Retained old keys verify previous pages; operators keep them at least 15m30s. Every client cursor error is `400 invalid_cursor`, without details. HMAC operation failure is 503. Startup and readiness reject invalid/shared keys; readiness also explicitly rejects duplicate kids.
- **Bounded SQL and monitoring.** `SET LOCAL statement_timeout = '2s'` runs on the list transaction's connection and is reset on commit/rollback. SQL cancellation is a 503 with no partial page. A real table lock test verifies timeout and subsequent recovery. List durations at least 500 ms produce a safe warning below the hard timeout. Production plan monitoring is an operational gap, not a per-request EXPLAIN query.
- **Storage boundary now, S3/uploads in C13.** `ObjectStorage` exposes read/delete with explicit results and opaque keys. Development/test local reads stream an opened regular file, reject traversal/symlinks and close on cancellation; deletes are idempotent. Local access is disabled in production; until C13, a stored production photo returns 503. Missing stored objects are consistency errors (503), whereas no photo/deleting/deleted returns 404 without storage access. A backpressured stream wrapper replaces transport errors with a safe application error. An early failure is a 503; after sending bytes it aborts the connection. No key/path/library message is sent or logged.
- **Validation and handoff.** Contract tests/stubs were committed failing before implementation. Added unit tests cover query/cursor parsing, rotation/expiry, safe projection, read ordering, query generation, failures and local storage safety. HTTP tests cover permissions, all statuses, limits, tied keysets/both directions, later inserts, literal prefixes, cursor binding, stream errors and the real timeout. The real-server smoke uses local `.env` settings with an isolated temporary database because the dev database has no existing admin; that database is removed afterward. C12 does not require a separate phase review; the phase 2 review remains at C14.
- **Final self-review:** rejected trailing line terminators explicitly in ID, page-size and local-key validation (JavaScript `$` can match before a final newline); added regression tests. The pagination test also inserts a row exactly at `snapshotAt` in both sort directions. Test search prefixes/names/cursors are included in leak checks, and the suite keeps its entire log capture. Additional tests after the initial failing commit cover real SQL timeout/recovery, early stream errors, storage safety and these review regressions.

## D52: C13 transactional profile and email changes (2026-11-17)

- Reuse C12's safe projector, broad ASCII ID validation, UUID ownership comparison and shared guard order. PATCH validates a nonempty field whitelist, then foreign/direct-field permissions before lookup; email/status require `update_any` even for self. All writes recheck target status under the user lock. Only actual normalized changes alter `updated_at`; unchanged administrative email does not consume a challenge. A direct changed email consumes outstanding email challenges as `admin_override`, and blocking consumes login/email challenges as `user_inactive`.
- Extract the last-manager SQL into `rbac-invariant.ts`, shared with RBAC administration. Status writes acquire `rbac_policy_state` before the user row. An actual block checks the invariant after updating inside the same transaction, so refusal rolls everything back. Status changes bump the policy version under that lock. Name/email-only changes need no policy lock.
- Reuse `ChallengeEngine` for self-only email initiation/resend/confirmation, with the existing OTP/link, TTL, cooldown, fifth-attempt and commit-before-SMTP semantics. Confirm claims and updates email inside a savepoint. A unique-email failure rolls back claim/update to that savepoint, consumes `email_conflict`, commits it, then returns 409. Wrong OTP refusals also commit their attempt count. A user found inactive under the lock consumes the outstanding challenge and gets 401.
- `RateLimiter.consume()` optionally accepts the current manager. Email-change quota is reserved on the same connection/transaction as challenge creation/resend, after the engine accepts. A refused sixth email rolls back the replacement and keeps the prior challenge; SMTP failure occurs after commit, retains its quota and challenge, and returns safe recovery fields. This also avoids exhausting the connection pool by opening a second rate-limit connection while each request holds a user transaction.
- Fastify's validated JSON now gets a linear duplicate-decoded-key check, including escaped aliases and nested objects. This closes PATCH's duplicate-field contract without replacing JSON parsing or weakening prototype-poisoning checks. No unknown/value data is attached to errors.

## D53: C13 private storage and reliable cleanup (2026-11-17)

- The author chose AWS S3 and configured bucket `backend-course-52` in `eu-central-1`. Credentials remain only in local `.env`; they were never printed/committed. A tiny real S3 list/write/stream/read/delete check passed, then the live HTTP smoke verified private object access, normalized photo download, profile edits and email confirmation. Its objects and temporary DB were removed. `docs/storage-setup.md` and the scoped IAM policy explain the setup.
- Extend `ObjectStorage` with write/list. Database keys stay flat random UUIDs (128 random bits) plus `.webp`, with no owner or original filename. S3 adds the private configured prefix and uses conditional writes to avoid overwriting; local storage uses exclusive, no-follow regular-file writes with mode 0600. Local storage is disabled in production. S3 commands use explicit validated credentials, one attempt and bounded I/O. AWS-issued credentials are external credentials, not application-generated signing/HMAC keys; they do not belong in `SECRET_KEY_NAMES` or the key generator. Redaction and test leak checks cover both AWS credential fields.
- Validate exactly one multipart file, no fields, and a 5 MiB read limit. Compare MIME/signature/decoder; reject animation and dimensions outside 64–4096. Apply EXIF orientation, fit within 1024 without enlargement, strip metadata, and encode one WebP capped at 2 MiB. Sharp has a decoded-pixel bound and a ten-second processing timeout. The three new packages are pinned to releases older than two weeks and installed with scripts disabled; native conversion was exercised.
- Normalize before a transaction; inside it acquire the shared adoption advisory lock, write the object, lock/recheck the user, switch the reference and queue old-object cleanup. Starting the transaction for its advisory lock makes no user-row change before successful storage. Concurrent uploads can share that lock. Reconciliation takes it exclusively before checking references/deleting: an upload delayed beyond the one-hour threshold cannot be swept just before adoption.
- Cleanup uses the existing schema: hold a `FOR UPDATE SKIP LOCKED` job row through bounded storage deletion, then commit attempts/result. Missing objects succeed; failed deletes retry after one minute, and the fifth failure becomes terminal. No new lease/status schema is needed for this short I/O operation. Never delete a key still referenced by a user. Logs carry job ids and safe results, not keys.
- Reconciliation runs every five minutes, lists only the dedicated namespace, and removes only old, unreferenced generated keys. Each run bounds pages/deletes and its time budget, retains listing progress, and stops on storage deletion failure. The new photo-reference index supports its checks. An unavailable exclusive adoption lock postpones a sweep safely.
- `STORAGE_WORKERS_ENABLED` defaults true; test apps disable automatic workers and call them explicitly. Live smoke uses a temporary reference DB with automatic workers disabled: sweeping a persistent real bucket using an empty test DB would be incorrect. CI uses local/fake storage plus dummy S3 production-boot settings; no real AWS credentials are needed there. Version purging and workload-role credentials remain explicit gaps.

## D54: C13 review findings and validation (2026-11-17)

- An image decoder may expose only the default frame of APNG. Reject the PNG `acTL` chunk explicitly before normalization; a generated two-frame APNG fixture tests this path alongside animated WebP. Input signature, corruption, dimensions, metadata, non-enlargement and final output-size limits have tests.
- The real retry test caught PostgreSQL inferring one parameter as both enum and text. Explicitly cast the cleanup status parameter. Retry assertions compare `next_attempt_at` with the row's database-written timestamp, not the host clock: local Postgres/host clock skew made a host-time assertion flaky.
- A single unlocked reference read is insufficient after a lost COMMIT acknowledgement. Compensation now takes the target user lock in a fresh transaction, waiting for the original commit/rollback, then checks adoption before deleting. If the database cannot decide, leave the object for reconciliation. Unit tests cover uncertain commit, status-race rollback, referenced-object preservation and deferred cleanup.
- Orphan sweeps stop on delete failure and bound their time while holding the exclusive adoption lock; they do not spend an unbounded outage retrying objects and blocking uploads. Current references, recent objects, old orphans and pending-adoption coordination have tests.
- Tests-first commit: `338fc24` records failing inputs, image and HTTP contracts with compiling stubs. Subsequent tests add storage boundaries, savepoints, transaction failures, real cleanup/reconciliation, SMTP failure, magic links, email quota/races, last-manager safety and shared PATCH/photo limits. The final gate includes coverage, repeated full HTTP suites, fresh migration apply/revert/reapply and drift checks, live AWS HTTP smoke and complete log-leak checks. Individual phase review is scheduled at C14 by the roadmap; C13 received self-review.
- Transactional email quota uses the quota statement's timestamp rather than the transaction's start: earlier user/challenge lock waits must not backdate the hit. Standalone limiter calls retain their prior behavior. A real PostgreSQL test separates transaction start from quota execution and verifies the recorded hit is later.

## D55: Photo keys carry the full required 128 random bits (2026-11-17, amends D53)

Final review caught an entropy mismatch in D53: UUID v4 has 122 random bits after its fixed version/variant bits, rather than the required minimum of 128. Generate photo keys with `randomBytes(16).toString('hex') + '.webp'` instead. Reconciliation recognizes the new 32-hex format and earlier UUID-shaped objects, preserving compatibility with existing fixtures/objects; references always protect live keys. The generated-key assertion and a reconciliation regression cover the new format. No schema change is needed, and keys remain independent of users and filenames.

## D56: Resume C13 on merged C12 and complete the handoff (2026-11-17)

- PR #13 is now confirmed merged (`e284a5d`); PR #14 targets `main` and its diff contains C13 only. The roadmap records C12 complete. The interrupted 128-bit key correction and its reconciliation regression are retained and validated before pushing.
- Two intermittent failures in the interrupted run affected health/OpenAPI and CSRF tests using per-request Supertest sockets. Those suites now use the existing Fastify injection transport and retain their status, CORS, security-header, readiness and handler-execution assertions. This removes per-request server/port churn; live smoke and CI still exercise real sockets. The earlier transient failures are not treated as passing validation; repeat the complete suite for the final head.
- Complete the spec 1.5 request audit for rejected input and failures before service transactions. A controller-scoped interceptor logs verified identity, request id, operation, allowlisted PATCH field names and result/category. It never copies body values, arbitrary keys or exception messages, and includes a target only on success; existing service events retain target details after admission. Syntax/parser failures before authentication remain covered by the safe request-completion log. Unit and HTTP tests check refusal auditing and data omission.

## D57: An idempotent deletion confirm is answered before the session check (2026-11-18)

Spec 1.6 §1.3.2 step 2 checks the `Idempotency-Key` before access, CSRF and RBAC, because after acceptance the account is `deleting` and its cookie no longer authenticates. The author chose the spec-literal option over keeping the route fully protected.

- A `@RequirePermission` route may add one `@Replay(name)`. The route guard asks the named matcher (`IdempotentReplays`, registered by the owning feature) before the chain. `replay` goes to the handler after CSRF and the route's IP limits (the receipt branch's treatment). `conflict` is `409 idempotency_conflict`. `none` runs the full chain. A route whose matcher isn't registered falls back to the full chain, so a wiring mistake never opens a route. `@Replay` without exactly one pair, twice, or next to `@Receipt` is a declaration conflict.
- The deletion matcher only recognises a well-formed key whose job belongs to the path's user (UUID case ignored, as with ownership in D51). The handler repeats the same check, which also covers a job committed between the guard and the handler. The answer carries only `jobId`, `status` and `statusUrl`, the same data the receipt status endpoint returns for that key.
- A malformed key, or a key with no job, runs the full chain first. Validation errors (400) therefore come after the session check, consistent with D51's "shared guard before validation".
- The admin `DELETE` validates the path and the key (400) before the self check and `users@delete_any` (403), in the spec's step order. Neither reads the target.

## D58: Deletion status branches and receipt errors (2026-11-18)

- The author chose to answer a malformed `Deletion-Receipt` with the same `404 not_found` as an unknown or mismatched one, so probing learns nothing from the format check. A malformed `Idempotency-Key` on the writes stays `400`.
- The guard decides the branch: with a non-empty receipt header it takes the receipt branch and never reads the cookie, so the handler sees no verified user and runs the self branch. Otherwise the chain sets the user and the handler runs the admin branch. An admin cookie sent with a receipt is ignored.
- Self branch: the job's `user_id` must equal the path id exactly (no case folding), per "exact match" in §1.3.4. Admin branch: own id is `403 forbidden`, then `users@delete_any`, then path validation and the job lookup (404).
- `finishedAt` is present on every answer and is non-null only for `succeeded`.

## D59: The deletion acceptance transaction (2026-11-18)

- Self: policy lock → user lock → the engine locks and checks the challenge, with `userEligible` = active, so method, consumption and TTL refusals come first and an inactive user consumes it as `user_inactive` (mapped to 401). An existing job under another key consumes the challenge as `job_exists` and is the 202 answer. Otherwise the challenge is claimed `confirmed` before acting (claim-then-act).
- `accept()` inserts the job (`queued`, `attempts = 0`, `next_attempt_at = clock_timestamp()`, a random tombstone), sets `deleting`, deletes the user's roles, then runs the shared `assertRbacManagerRemains()`, bumps the RBAC version and consumes the user's other challenges. Registration, login and email-change challenges are consumed as `user_inactive`; an outstanding deletion challenge (admin path) as `job_exists`. The invariant runs after the status change, so the user no longer counts as an active holder. A refusal throws and rolls back everything, including the claim, so the challenge stays usable (§1.3.2 step 9: "without job and without status transition").
- A concurrent insert of the same key for another user hits `pk_deletion_jobs` and becomes `409 idempotency_conflict`. One job per user can't race, because the user row is locked.
- Admin: an existing job is locked after the user and returned. A `failed` one is requeued (attempts, lease and error reset, same tombstone) and logged as `deletion_admin_retry`. `deleting`/`deleted` without a job logs `deletion_consistency_violation` and answers 503.
- Starting or resending a challenge while a job exists is `409 deletion_exists` (a new code; `challenge_conflict` means a consumed challenge). It is checked after the challenge lock, so the order stays user → challenge → job. An inactive user at challenge time consumes the outstanding challenge and gets 401, like email change (D52). Both reserve a `deletion_challenge_emails` slot (5 per user per hour, resends included) in the same transaction.

## D60: The deletion worker (2026-11-18)

- One `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` claims a due `queued` job or a `running` one whose lease expired: `running`, `attempts + 1`, `lease_until = now + DELETION_WORKER_LEASE_SECONDS`, no `next_attempt_at`. Several instances can poll safely. Before claiming, a job with 5 starts whose lease expired becomes `failed` (`attempts_exhausted`); the claim filters `attempts < 5` (ck_deletion_jobs_attempts).
- The erasers run outside any transaction. Every later write is fenced by `status = 'running' AND attempts = <claimed>`, so a run whose lease expired and was re-claimed changes nothing (`deletion_job_lease_lost`).
- A failure goes to `queued` with `next_attempt_at = now + 60 s` and the safe code, or to `failed` at the 5th start or on `permanent_failure`. A final transaction that doesn't commit is `retryable_failure` (`finalize_failed`).
- Finalization takes policy → user → job locks. `succeeded` plus `deleted` is an idempotent success. It requires `running` with our attempt and a `deleting` user, and a remaining `photo_key` is retryable (`photo_remaining`). It deletes all four challenge tables' rows, deletes leftover roles (bumping the RBAC version only if rows were removed), writes the tombstone and clears the PII, and marks the job `succeeded` with `finished_at`.
- It polls every 5 s and does not start automatically when `NODE_ENV=test`; tests call `run()`. It touches storage only through the erasers, so it is safe next to an isolated smoke database.

## D61: User-data erasers and their readiness check (2026-11-18)

- `USER_DATA_OWNERS` (`src/modules/erasure/user-data-erasers.ts`) is the reviewed list of modules that store user data, like `RATE_LIMIT_POLICIES` for limits. The `user_data_erasers` readiness check is down while any listed owner has no registered eraser (spec 1.6 §1.6). Part 2 adds `transformations` to the list together with its eraser.
- `eraseAll()` runs the erasers in registration order and stops at the first failure; the job is retried as a whole and every eraser is idempotent. A thrown error becomes `retryable_failure` with `eraser_error`, and a code outside `^[a-z][a-z0-9_]{0,63}$` is replaced by `eraser_failed`, so a library message never reaches `last_error_code`.
- The profile eraser deletes the photo object (a missing one is success), then clears `photo_key` only if it is still that key and the user is `deleting`. It refuses (`permanent_failure`) for a user that isn't being deleted. `deleting` already blocks uploads and photo edits, and an in-flight upload that loses the race compensates its own object (D54).

## D62: Deletion logs carry no ids (2026-11-18)

- Spec 1.6 §1.5 keeps `jobId`, keys, receipts, actor and target ids out of deletion logs. Deletion events log only the operation, mode or branch, and a safe result code. The challenge engine already omitted deletion challenge ids (`logIds: false`).
- The shared authorization steps (access check, RBAC decision, ownership) log the actor id for every other route. `logsIds(operation)` (`src/core/logging/id-redaction.ts`) omits it for operations of `UsersDeletionController` and `UsersDeletion`; the guard now passes its operation name to the authenticator.
- The e2e leak check covers every log line of the deletion suite. Only lines from the requests it makes to other specs' routes (profile read, role assignment, re-registration) are exempt from the id check, matched by request id. Secrets, keys, emails, OTPs and tombstones are checked in every line.

## D63: Role assignment refuses accounts being deleted (2026-11-18)

Spec 1.6 requires role assignment to re-check the target status under the shared lock and reject `deleting` or `deleted`. `PUT /admin/rbac/users/{id}/roles` now does so with `409 conflict` after locking the user, so a deletion's role removal can't be undone while the worker runs.

## D64: C14 and phase 2 review findings (2026-11-18, amends D58)

`/code-review medium 25a9c5b...HEAD` covered the whole of phase 2 (C12–C14). `/security-review` on the branch found no vulnerabilities.

Fixed:
- **Concurrent confirms with one key.** Both requests could read "no job" before either committed. The second then met a `confirmed` challenge or a `deleting` user and got 4xx instead of the receipt. The key is now looked up again inside the transaction, after the policy and user locks, and answers as a replay (or a 409 for another user). An e2e test sends two confirms at once; it fails without the fix.
- **Receipt branch and UUID case (amends D58).** The status receipt branch compared the job's user with the path id case-sensitively, so a client that used an uppercase path everywhere else could never read its status. It now uses the same case-insensitive comparison as ownership (D51). Unknown, malformed and other users' receipts are still the same 404.
- **The replay check during an outage** is `503 authorization_unavailable`, like the other chain steps. The filter already turned it into `503 service_unavailable`; it was never a 500.
- **Shared id rules.** `uuidOrNull` and `sameUserId` live in `src/modules/users/user-ids.ts` and the read, update and deletion services use them. The deletion flow and worker derive their challenge scenarios and tables from `CHALLENGE_SCENARIOS`, so a new scenario is consumed at acceptance and deleted at anonymization without another list to update.
- **Rate limiter clock.** `consume()` no longer rewrites `now()` in its SQL text. The fragments take the clock as a parameter (`now()` standalone, `statement_timestamp()` in a caller's transaction, D54).

Not changed, recorded in `docs/known-gaps.md`:
- The replay lookup runs before CSRF and IP limits on every confirm. It is one primary-key read, the same cost as the access check's user read that every protected request already does. Running CSRF first would turn an unauthenticated cross-origin write into a 403 instead of the 401 that spec 1.3 orders.
- Storage cleanup holds its job row lock, and the orphan sweep its exclusive adoption lock, through bounded storage calls. That was D53's deliberate trade-off: no lease schema for short I/O. Under slow S3 this lengthens transactions and briefly delays uploads.
- The deletion lease isn't renewed while erasers run. Erasers are bounded well under the 300 s lease (the profile eraser makes one 5 s-bounded storage call), and the attempt fence keeps an overlapping run from changing anything. A Part 2 eraser that can approach the lease must renew it or stay bounded.

## D65: History rows start once the pair is known (2026-11-18)

Spec 2.0 says an error writes an `error` row, but steps 4–5 (multipart, size, parameters, format detection) run before any pair exists. The author chose to record only once the request names a registered source → target pair with an input inside its limit. From then on every outcome gets one row: success, a converter refusal (400), a result over the limit (413), a timeout (504) or a converter/worker failure (503). Malformed multipart, an oversized input, unknown fields, an unsupported extension or an unregistered target are refused with no row, because there is nothing to record a format for. Every row therefore has non-null formats and input size, which `ck_transformations_formats` and `ck_transformations_sizes` enforce.

## D66: Modules seed their own permission after the RBAC bootstrap (2026-11-18)

- Spec 2.0 §1.1: on first install the transformations module creates its permission and actions, grants `convert`, `history` and `download` to `user` and everything to `admin` if present, and never restores a removed grant. Modules register a declarative `PermissionSeed` with `RbacPermissionSeeds` in `onModuleInit`. `RbacBootstrap.run()` applies every seed after its own step on every start, whatever the bootstrap decided. So an installation configured before the module existed gets it at the next start, and the test helper `ensureBootstrapped()` gets it too.
- A seed acts only while its permission doesn't exist, under the policy lock, and bumps the RBAC version. Without a `user` role it creates nothing (`no_default_role`): a permission created then would never reach `user`, because the next start would find it present. The module's `transformations` readiness check stays down until both the `user` role and the permission exist ("no role `user` — module readiness does not pass").
- A fresh installation is therefore live but not ready until RBAC is bootstrapped (`RBAC_BOOTSTRAP_ADMIN_USER_ID` naming an active user). The Docker `HEALTHCHECK` uses liveness, so the container stays healthy; only traffic routing waits. CI's Docker smoke now checks that path: not ready on the fresh database, then an admin row, a restart with the bootstrap id, readiness and the seeded permission.
- This is a direct RBAC write like the bootstrap's (spec 1.1 §1.3.6 allows it with the version bump). It doesn't go through `RbacAdminService.change()`, which needs an acting `rbac@manage` user.

## D67: Converters run in a piscina worker pool (2026-11-18)

- piscina 5.3.2 (released 2026-08-28; one optional prebuilt dependency, no install scripts) runs converters off the event loop (spec 2.0 §1.6). `TRANSFORMATION_WORKER_THREADS` (default 2) bounds the threads, the queue is piscina's `auto` (threads²), and a full queue is a `converter_failed` 503. The HTTP request waits for its result; no job queue is used.
- Each direction's `timeoutMs` aborts the task. piscina then terminates that thread, so a CPU-bound library is really stopped (the e2e "hang" converter spins forever) and the pool starts a new one. The timeout includes queue wait, so a saturated pool answers 504 rather than piling up requests.
- A converter is a module exporting `converter` (`src/modules/transformations/converter.ts`) that the worker `require()`s by the absolute path in its registry entry. Only registry paths are ever loaded. Worker-side files use relative imports only, because threads don't resolve `@/`. Under ts-jest the pool starts threads with `-r ts-node/register/transpile-only` and loads `.ts` files; the build loads `.js`. A smoke script ran the compiled pool, including termination.
- The worker writes the result through a byte counter into an exclusively created (`wx`, 0600) file. Passing the direction's output limit fails the stream at once (`result_too_large`). A thrown error or an unknown code becomes `converter_failed`, and the library's message never leaves the worker. A content type or extension that could break a header is refused. Partial output is removed.

## D68: The shared conversion procedure (2026-11-18)

- `TransformationService.handle(userId, request, reply, operation)` is what the text (C16) and image (C17) endpoints call after the guard has checked access, CSRF and their permission. It reads the upload, lets the operation resolve source, target and parameters, converts, and streams the result. Endpoints declare `@HttpCode(200)`, because Nest's POST default is 201.
- The upload intake accepts exactly one non-empty `file` part and only the operation's text fields, each once (1 KiB max). The original name yields only a lowercase extension. The file streams straight into the temp area under the limit for its format (415 for an unsupported one, 413 past the limit, 400 for anything malformed), with the operation's largest limit as the parser's hard cap.
- Converter codes map to fixed HTTP codes: `invalid_input`, `structure_mismatch` and `unsafe_input` → `400 invalid_file` (a new code); `content_mismatch` → 415; `result_too_large` → 413; `timeout` → 504; `converter_failed` → 503. History stores the converter code; the client sees only the mapped one. A failed history write returns no result (503) and removes the output.
- The result is opened, then its name is removed at once. The open descriptor keeps the bytes readable until the response is sent (POSIX semantics, true of the Alpine image and macOS), so a client that disconnects leaves nothing behind. The response has `Content-Disposition: attachment; filename="converted.<ext>"`, `X-Transformation-Id`, `nosniff` and `no-store`.
- The temp area (`TRANSFORMATION_TEMP_DIR`, default `<os tmpdir>/backend-course-transformations`) is one 0700 directory with 128-bit random names. `remove()` refuses anything that isn't one of its own names. Leftovers older than an hour are swept at start. A `transformation_temp` readiness check reports it.
- One `transformation` log event per finished conversion carries `transformationId`, `userId`, type, formats, sizes, result, the safe code and duration (spec 2.0 §1.5); the request log adds `requestId`. Content, names and paths are never logged; the e2e leak check covers them.

## D69: Transformations eraser and history schema (2026-11-18)

- `transformations` joins `USER_DATA_OWNERS`, and `TransformationsEraser` deletes the user's rows in batches of 1000 (spec 2.0 §1.3.4). C19 deletes stored objects before their rows. A database failure is `retryable_failure` (`history_unavailable`).
- The table keeps only safe metadata. Formats are text with the pattern `^[a-z0-9]{1,16}$` (not an enum), so a new pair needs no migration (user story 3). Status and type are enums. A CHECK ties `success` to an output size and no error code, and `error` to a code and no output size. Sizes are `bigint`, and the index `(user_id, created_at, id)` serves spec 2.3's keyset pages. Storage columns arrive with spec 2.4 (C19).

## D70: Text representation rules chosen by the author (2026-11-18)

Spec 2.1 §1.3.2 leaves four rules open. The author chose:
- **XML root:** JSON/YAML → XML needs a top-level object with exactly one key, which becomes the root element. An array, several keys or a scalar is `400` (`structure_mismatch`). XML → JSON/YAML returns the same shape, so XML ↔ JSON/YAML round-trips exactly. `@name` keys are attributes, `#text` the text and arrays repeated elements, as the spec says.
- **XML → CSV:** only `<rows><row><field>…</field></row></rows>`, the shape CSV → XML writes. Each row needs flat text fields with the same names and no attributes or text of its own. Anything else, including an empty `<rows/>` (a CSV needs a header), is `structure_mismatch`.
- **Values stay strings:** CSV and XML have no types, so `"007"`, `"1e3"` and `"true"` stay as written in JSON/YAML; nothing is guessed. JSON ↔ YAML keeps real types. JSON/YAML → CSV/XML writes numbers and booleans as text and `null` as an empty cell or element.
- **MIME types:** each extension accepts its own types plus `application/octet-stream` and `text/plain`, which many clients send for any file. A clearly different type is 415. Content that doesn't parse is a 400, not a 415.

## D71: How each format is read and written safely (2026-11-18)

- **Encoding:** strict UTF-8 (`TextDecoder` with `fatal`); one leading BOM is dropped. Invalid bytes are `invalid_input`.
- **CSV (papaparse 5.7.0):**
  - The delimiter is fixed to `,`, so nothing is guessed, and blank lines are skipped.
  - A header is required, with no empty or duplicate names. Every row must have exactly the header's fields; a quote error or field-count mismatch is `invalid_input`.
  - Output quotes only where needed and doubles embedded quotes, with `\n` line endings and a final newline. Columns follow the first object's key order; every object must have the same key set and only scalar values.
- **JSON:** `JSON.parse`, then `JSON.stringify` with 2-space indentation. Nesting deep enough to exhaust the stack is `invalid_input`, never a 500.
- **YAML (yaml 2.9.1):** the safe loader means the 1.2 core schema, no custom tags and no merge keys. It accepts one document only, refuses duplicate keys, and refuses any warning (an unresolved tag such as `!!python/object` is one). Aliases are expanded at most 100 times. Values JSON can't hold (`.inf`, `.nan`) are `structure_mismatch`. Output disables aliases and line folding.
- **XML (fast-xml-parser 5.12.0):** any `<!DOCTYPE` or `<!ENTITY` is refused before parsing (`unsafe_input`), because the parser expands internal DTD entities when it sees a DOCTYPE. Without a DTD only the five predefined entities exist, and nothing is ever fetched. The document must validate and have exactly one root (the parser alone accepts several). Values and attributes stay strings; comments, processing instructions and the declaration are dropped. Element and attribute names written must match `^[\p{L}_][\p{L}\p{N}_.:-]{0,199}$`, so a CSV header like `first name` can't become an element. Output is indented and escaped, with an XML declaration.

## D72: Text endpoint limits and the save flag (2026-11-18)

- `TEXT_CSV_MAX_BYTES`, `TEXT_JSON_MAX_BYTES`, `TEXT_XML_MAX_BYTES` and `TEXT_YAML_MAX_BYTES` default to 10 MiB (spec 2.1 §1.1). The result limit is a fixed 50 MiB. `TEXT_CONVERSION_TIMEOUT_MS` defaults to 30 s and is configurable, so tests can prove the 504 and operators can tune it.
- `targetFormat` must be one of the four and differ from the source, which comes from the extension (`.yml` is YAML); otherwise 400. `save` must be `true` or `false` (400 otherwise) and is accepted now, but saving itself arrives with spec 2.4 (C19).
- Each converter reads the whole input (at most its limit) and builds the result in memory inside its worker thread, then writes it at once. The worker's byte limit refuses an oversized result (413) without returning anything partial.

## D73: Image rules chosen by the author, and the defaults around them (2026-11-18)

Spec 2.2 leaves three behaviours open. The author chose:
- **Oversize is 413.** A result over 4096 px per side or 16,777,216 px is `413 payload_too_large` with history `result_too_large`. That covers a PNG/JPEG input that big, an SVG's own size, or a size derived from one option. Nothing is resized behind the client's back. An explicit `width`/`height` outside 1–4096 is still a 400 option error. A raster's size is read from its header and checked before decoding.
- **Both SVG dimensions mean exactly that size.** The drawing is stretched to `width × height`. One dimension keeps the aspect ratio (spec), and none uses the intrinsic size.
- **Animated PNGs are refused** (`unsafe_input`, 400), like profile photos (D54): the `acTL` chunk before `IDAT` marks an APNG, whose frames libvips can't all read.

Other choices:
- The EXIF orientation is applied (`rotate()`) and then every bit of metadata is dropped, because sharp writes none unless asked. A sideways photo stays upright without its EXIF (spec 2.2 §1.6).
- A `.png` / `.jpg` / `.jpeg` upload must carry its signature (`content_mismatch`, 415). A damaged file or a decoder warning (`failOn: 'warning'`, as in D53) is `invalid_input` (400).
- MIME types: each format's own types plus `application/octet-stream`, as in D70; `text/plain` is not accepted for images.
- A direction outside the four (to SVG, to itself, to anything else) is 415 (spec 2.2 §1.4: "format or direction is not supported"). Spec 2.1's same-format rule is a 400, because its validation table says so.
- The JPEG result is named `converted.jpeg`, matching `targetFormat`.

## D74: SVG safety and sizing (2026-11-18)

- **Safety (spec 2.2 §1.3.3):**
  - Any `<!DOCTYPE` / `<!ENTITY` is refused before parsing (as for XML in D71). The document must validate, decode as strict UTF-8 and have exactly one root, `svg`; any other root is `content_mismatch`.
  - A full walk refuses `script`, `foreignObject`, `iframe`, `embed`, `object`, `audio`, `video`, `canvas`, `handler` and `listener` (any case or prefix). It also refuses any `on*` attribute and any `href`/`src` (including `xlink:href`) that isn't a same-document `#id`.
  - CSS is refused if it contains `@import` or a `url()` that isn't `#id`, whether in an attribute, a `style` attribute or a `<style>` element.
  - `data:` URIs are refused too: they aren't external, but they embed documents this check never sees.
- **The renderer is resvg 2.6.2:** no network and no scripts. With every reference refused, it never reads a local file either.
- **Intrinsic size:**
  - An absolute `width` and `height`, or a valid `viewBox`, is the intrinsic size.
  - Without one, resvg would fall back to the drawing's bounding box, so the document is nested in a 1024×1024 outer `<svg>`. Percentages then resolve against 1024, the spec's default, and no attribute is rewritten.
  - The final size is computed and checked against the limits before anything is rasterised.
- **Rendering:** resvg renders at a single zoom of at least one pixel per side, then sharp stretches to the exact size. A requested shape far from the drawing's (say 4096 × 2 for a tall SVG) never makes a sub-pixel or oversized intermediate; a zoom whose intermediate would pass the pixel limit is `result_too_large`.
- **Output:** a PNG keeps transparency; a JPEG is flattened onto `background` (default `#ffffff`) at `quality` (default 85).

## D75: Image limits and timeouts (2026-11-18)

- `IMAGE_PNG_MAX_BYTES`, `IMAGE_JPEG_MAX_BYTES` and `IMAGE_SVG_MAX_BYTES` default to 10 MiB, and `IMAGE_CONVERSION_TIMEOUT_MS` to 30 s (spec 2.2 §1.1). The byte cap on a result (100 MiB) is only a backstop; the pixel limit is the real bound.
- sharp gets its own timeout, one second before the pool's (minimum 1 s), so a slow encode usually stops cleanly with history `timeout` before piscina terminates the thread. resvg renders synchronously and can't be interrupted mid-render, so the pixel limit is what bounds it.
- `options` is a JSON object, at most 1 KiB like every field. `quality` (1–100) and `background` (`#RRGGBB`, stored lowercase) apply only to a JPEG result; `width`/`height` (1–4096) only to an SVG source. Unknown or inapplicable fields are 400.

## D76: Transformation history pages and their cursor (2026-11-18)

- **Routes:** `GET /api/transformations/history` (`transformations@history`; the user id comes from the session) and `GET /admin/users/{userId}/transformations/history` (`transformations@history_any`, checked by the guard before any lookup). Both are under `history_user`, 60 per user per minute.
- **Admin order:** after the guard, the path id is validated (D51: 1–128 safe characters, a valid non-UUID binds `null`, so it is an absent target, not a cast error), then the query, then the user lookup (404). An admin may read their own history through this route; spec 2.3 doesn't forbid it.
- **Query validation follows the permission**, as the user list does (D51). It refuses unknown and repeated parameters, empty values, `limit` outside 1–100, unknown `type`/`status`, and formats that aren't a registered source or target (so a new pair becomes filterable on its own). Times must be RFC 3339 with an explicit zone, a real calendar date, normalised to UTC milliseconds, with `createdAtFrom < createdAtTo`.
- **Paging:** `created_at DESC, id DESC`, keyset `(created_at, id) < (cursor)`, `limit + 1` rows of only the response fields, no OFFSET and no count. It walks `idx_transformations_user_created_at_id` backwards inside a transaction with `SET LOCAL statement_timeout = '2s'` like the user list. No snapshot boundary is needed: new rows sort before every cursor, so they can't appear in later pages.
- **The cursor isn't signed:** base64url JSON `{v: 1, createdAt, id, filters}`. Spec 2.3 asks for exactly this, unlike the user list's signed cursor (spec 1.7). A crafted position only positions a page of a history the caller may already read. Decoding demands canonical base64url, the exact key set, version 1, a millisecond UTC time, a lowercase uuid and a filter set equal to the current query's (every key, missing filters as `null`). Anything else is `400 invalid_cursor`.
- **Items:** spec 2.3 §1.3.4 without `userId`. `storageStatus` is `not_requested`, `hasStoredFile` `false` and `fileExpiresAt` `null` until spec 2.4 adds the columns (C19).
- **Audit log (spec 2.3 §1.5):** `transformation_history` with actor, scope (`self`/`admin`), the target only once found, the names of the filters used (plus `cursor`), limit, count, result or failure category, and duration. A read of 500 ms or more is a warning. Filter values and the cursor are never logged.

## D77: History retention (2026-11-18)

`TransformationRetention` deletes rows older than `TRANSFORMATION_HISTORY_RETENTION_DAYS` (default 90). It runs every 10 minutes outside tests, in batches of 500 through the new `idx_transformations_created_at`, at most 20 batches per sweep, and never overlaps itself. Spec 2.4 (C19) will delete a stored object before its row; until then rows have no objects.

## D78: Audit of C14–C18 against specs 1.6 and 2.0–2.3 (2026-11-18)

After C18 merged, the author asked for every checkpoint of the session to be checked against its spec again. Each section's rules (contract steps, the §1.4 error list, §1.5 logging, §1.6 non-functional requirements) were walked against the code and tests. Result: everything the specs require is implemented and tested, except one gap and one small difference recorded below. Everything else that differs from a literal reading is an explicit author choice or a recorded decision.

**Gap found (to close in C19):**
- **Spec 2.2 §1.5 asks the conversion log to carry the image's final dimensions** ("input and result size, final sizes"). The `transformation` event logs byte sizes but not width × height. The image converter computes them (`ConvertedImage.width/height`), but the converter contract (D67) doesn't pass them back. Fix: an optional `width`/`height` in `ConverterOutcome`, validated in the worker and logged by the service. This is logging only; history (spec 2.3 §1.3.4) has no dimension fields.

**Small difference, recorded rather than changed:**
- **Admin and self deletion run the global last-manager check for every target** (`assertRbacManagerRemains()` after the roles are removed). Specs 1.6 §1.3.2 step 9 and §1.3.3 step 8 run it only when the target holds `rbac@manage`. While the invariant holds (at least one active holder exists), both give the same answer, because removing a non-holder can't remove the last holder. They differ only if the database already has no active holder, which no API path can produce (D45, D52). Then this code refuses every deletion with 409 rather than allowing ones that don't touch a holder.

**Deliberate readings, already decided (no change):**
- Spec 1.6: a confirm replay is answered before the session check (D57); a malformed receipt is 404 (D58); receipt user ids compare case-insensitively like ownership (D64, amending "exact match"); a malformed `Idempotency-Key` on confirm is checked after the guard (D57, following D51).
- Spec 2.0: history rows start once the pair is known (D65).
- Spec 2.1: single-key XML root, `rows/row` only for XML → CSV, values stay strings, octet-stream accepted, unparsable content is 400 rather than 415 (D70).
- Spec 2.2: oversize is 413, both SVG dimensions are exact, APNG is refused, `data:` URIs are refused (D73, D74).
- Spec 2.3: query validation follows the permission (D51 order); the cursor isn't signed (D76).

**Waiting for spec 2.4 (C19), as each spec allows:** `save=true` is validated but not acted on, `X-Save-Status` isn't sent, history storage fields are fixed (`not_requested`), and the eraser and retention don't touch stored objects yet.
