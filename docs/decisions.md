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
