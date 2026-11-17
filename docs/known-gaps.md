# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear. For the overall build order, see `docs/roadmap.md`.

## Database
- The schema covers Part 1 only. Still to come, each with its own migration: rate-limit counters (C5), the list-search indexes on `users` (C12), `transformations` (C15).
- `POSTGRES_MIGRATIONS_RUN=false` by default, so a deploy must run `npm run migration:run` (or set the flag) itself. CI and `npm run test:e2e` migrate their own database.
- `grants.all_actions = true` should mean "no `grant_actions` rows". That spans two tables, so it's enforced by the RBAC service (C10), not by a constraint.
- `ck_deletion_jobs_attempts` caps starts at 5. The deletion worker's claim (C14) must move an expired `running` job with 5 attempts to `failed`; a plain `attempts + 1` on it would violate the constraint.
- No entity is registered with a Nest module yet (`TypeOrmModule.forFeature`); each feature does that when it first needs a repository.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **Protected routes fail closed after authentication** (D25, D43): until the authorization chain lands in C11, every `@RequirePermission` route (and a receipt route called without its header) checks the access cookie (`401 invalid_session`), then answers `503 authorization_unavailable`.
- **CSRF on protected routes** runs after identity, so it arrives with the chain in C11 (D28). Public writes are checked now.
- **Rate limits are in place, but partly unused yet:** each policy is applied by the checkpoint that adds its route (registration C8, login and refresh C9, …). User-keyed ones start working with the protected chain in C11.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres and `POSTGRES_MIGRATIONS_RUN=true`, then checks the schema exists.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Harmless. Argon2 avoided the question by using `@node-rs/argon2`, which needs no install script (D40). When sharp arrives (C13), check that `npm ci --ignore-scripts` still gets its prebuilt binary.

## Route declarations
- The startup scan reports only the first path of a controller or handler that declares several aliases (`@Controller(['a', 'b'])`). The declaration applies to every alias anyway, since it sits on the handler.

## Rate limits
- `TRUST_PROXY` must be `true` behind a reverse proxy, or every client shares the proxy's IP budget. It must stay `false` when the app is reachable directly, or a client can pick its own IP with `X-Forwarded-For`.

## Registration
- Activation assigns no `user` role until RBAC exists (C10); the bootstrap then gives it to every active user without roles (spec 1.0 and 1.1).

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
- There is no per-query timeout: a connection attempt gives up after 5 s (D43), but a query on a live connection to a stalled server can still wait. "DB down → 503, not 401" is covered by unit tests with a failing fake, not by stopping Postgres in e2e.
- A body sent to a route that doesn't exist is still parsed first, so malformed JSON to a missing route answers `400 invalid_json`, not `404`.
- `text/plain` bodies are still accepted by Fastify's built-in parser and then fail DTO validation (`400`), rather than being refused with `415`.

## Testing
- `configure-app.ts` is covered only by e2e tests, not by unit coverage.
- `*.entity.ts` files are excluded from unit coverage (D16). They are checked by `test/schema.e2e-spec.ts` and `migration:check` instead.
