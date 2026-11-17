# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear. For the overall build order, see `docs/roadmap.md`.

## Database
- The schema covers Part 1, rate-limit counters (C5), and the user-list indexes (C12). The `transformations` table still needs its own migration (C15).
- `POSTGRES_MIGRATIONS_RUN=false` by default, so a deploy must run `npm run migration:run` (or set the flag) itself. CI and `npm run test:e2e` migrate their own database.
- `grants.all_actions = true` should mean "no `grant_actions` rows". That spans two tables, so the admin service never writes such rows and a snapshot reload refuses them (D45); a direct SQL change could still create one, and protected routes would then answer 503 until it is fixed.
- `ck_deletion_jobs_attempts` caps starts at 5. The deletion worker's claim (C14) must move an expired `running` job with 5 attempts to `failed`; a plain `attempts + 1` on it would violate the constraint.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **The client half of spec 1.3 §1.3.3** (one shared refresh after a `401`, a single retry, clearing state) belongs to a frontend this project doesn't have (D48). The server guarantees what it relies on: a guard `401` always comes before the handler.
- **Rate limits are in place, but partly unused yet:** registration, login, refresh, profile/photo reads and the user list are wired; update, deletion and history policies arrive with their routes.

## User reads and storage (C12)
- The storage read/delete port and single-instance development/test adapter are implemented. **Production photo reads return 503 until the S3 adapter arrives in C13.** Local filesystem access is disabled in production, not used as a fallback. Profile/list responses need no storage access.
- No upload route yet: C13 validates/normalizes WebP and writes opaque flat keys. The local reader trusts that write boundary; it does not re-encode images on every read.
- A stream failure before response bytes produces a safe 503; after bytes are sent, the connection is aborted. It cannot become a JSON error envelope after streaming starts. The storage error/path is never propagated.
- List queries warn at 500 ms and are cancelled by Postgres at 2 seconds. Automatic EXPLAIN/production plan monitoring is not configured; composite range and prefix indexes are supplied by the migration.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres and `POSTGRES_MIGRATIONS_RUN=true`, then checks the schema exists.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Harmless. Argon2 avoided the question by using `@node-rs/argon2`, which needs no install script (D40). When sharp arrives (C13), check that `npm ci --ignore-scripts` still gets its prebuilt binary.

## Route declarations
- The startup scan reports only the first path of a controller or handler that declares several aliases (`@Controller(['a', 'b'])`). The declaration applies to every alias anyway, since it sits on the handler.

## Rate limits
- `TRUST_PROXY` must be `true` behind a reverse proxy, or every client shares the proxy's IP budget. It must stay `false` when the app is reachable directly, or a client can pick its own IP with `X-Forwarded-For`.

## RBAC
- **Blocking and deletion don't run the last-holder check yet.** Only an active user counts as an `rbac@manage` holder, so blocking (C13) and deletion (C14) must take the policy lock and run the same check before they change the status.
- **Validation failures (400) on admin routes are logged by the error filter, not as `rbac_change` events;** refusals the service decides (404, 409, a 400 for a foreign action) are.
- **Bootstrap vs. a concurrent activation on another instance:** a user activated by a second instance while the first one's bootstrap transaction is open can end up with no role (neither the insert nor the backfill sees the other). Give them `user` through `PUT /admin/rbac/users/{id}/roles` (D47).
- **Before the bootstrap there is no `user` role,** so an activation assigns nothing; the bootstrap then gives `user` to every active user without roles.

## Authentication
- **Sessions are stateless (spec 1.2):** a refresh token can't be revoked before its 30-day `exp`, and reuse after rotation isn't detected. Blocking or deleting the user is the only way to end a session early, because every token is checked against the user's current status.
- **Key rotation:** `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are single keys. Changing one signs everyone out of that kind of token; there is no key ring like the user-list cursor has.

## Email challenges
- Registration (C8) and login (C9) use the engine; email change (C13) and deletion (C14) wire it in next.
- `resend_cooldown` is a 429 like the spec says; the 5-emails-per-user-per-hour limits for email change and deletion (`email_change_emails`, `deletion_challenge_emails`) are applied by those flows, not the engine.

## Mail
- Magic-link pages (`/auth/register/confirm`, …) belong to a frontend this project doesn't have (D35). To try a link flow, take the token from the mail in Mailpit (http://localhost:8025) and POST it yourself.
- The `smtp` readiness check is informational (D37): an SMTP outage shows as `smtp: down` while `status` stays `ok`. Alert on the check itself if mail matters to you.
- nodemailer is pinned to 10.3.1 (D36); newer 10.x releases exist.

## Errors
- Outside the C12 list transaction there is no per-query timeout: a connection attempt gives up after 5 s (D43), but another query on a live connection to a stalled server can still wait. The list uses a transaction-local 2-second SQL timeout and has a real lock-wait/recovery e2e test. "DB down → 503, not 401" is covered by unit tests with a failing fake, not by stopping Postgres in e2e.
- A body sent to a route that doesn't exist is still parsed first, so malformed JSON to a missing route answers `400 invalid_json`, not `404`.
- `text/plain` bodies are still accepted by Fastify's built-in parser and then fail DTO validation (`400`), rather than being refused with `415`.

## Testing
- `configure-app.ts` is covered only by e2e tests, not by unit coverage.
- `*.entity.ts` files are excluded from unit coverage (D16). They are checked by `test/schema.e2e-spec.ts` and `migration:check` instead.
