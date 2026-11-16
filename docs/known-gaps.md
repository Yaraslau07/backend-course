# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear. For the overall build order, see `docs/roadmap.md`.

## Database
- The schema covers Part 1 only. Still to come, each with its own migration: rate-limit counters (C5), the list-search indexes on `users` (C12), `transformations` (C15).
- `POSTGRES_MIGRATIONS_RUN=false` by default, so a deploy must run `npm run migration:run` (or set the flag) itself. CI and `npm run test:e2e` migrate their own database.
- `grants.all_actions = true` should mean "no `grant_actions` rows". That spans two tables, so it's enforced by the RBAC service (C10), not by a constraint.
- `ck_deletion_jobs_attempts` caps starts at 5. The deletion worker's claim (C14) must move an expired `running` job with 5 attempts to `failed`; a plain `attempts + 1` on it would violate the constraint.
- No entity is registered with a Nest module yet (`TypeOrmModule.forFeature`); each feature does that when it first needs a repository.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **Protected routes fail closed** (D25): until the authorization chain lands in C11, every `@RequirePermission` route answers `503 authorization_unavailable`, and so does a receipt route called without its header.
- **CSRF on protected routes** runs after identity, so it arrives with the chain in C11 (D28). Public writes are checked now.
- **Cross-site cookies:** for a frontend on another site, both auth cookies need `SameSite=None; Secure` (spec 1.2). That is a cookie attribute, set where cookies are issued (C9).
- **Rate limits are in place, but mostly unused yet:** each policy is applied by the checkpoint that adds its route (registration C8, login and refresh C9, …). User-keyed ones start working with the protected chain in C11.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres and `POSTGRES_MIGRATIONS_RUN=true`, then checks the schema exists.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Harmless today. When native deps arrive (argon2, sharp), approve their scripts with `npm install-scripts approve <pkg>`, and check that the Dockerfile's `npm ci --ignore-scripts` still gets prebuilt binaries.

## Route declarations
- The startup scan reports only the first path of a controller or handler that declares several aliases (`@Controller(['a', 'b'])`). The declaration applies to every alias anyway, since it sits on the handler.

## Rate limits
- `TRUST_PROXY` must be `true` behind a reverse proxy, or every client shares the proxy's IP budget. It must stay `false` when the app is reachable directly, or a client can pick its own IP with `X-Forwarded-For`.

## Mail
- Magic-link pages (`/auth/register/confirm`, …) belong to a frontend this project doesn't have (D35). To try a link flow, take the token from the mail in Mailpit (http://localhost:8025) and POST it yourself.
- The `smtp` readiness check is informational (D37): an SMTP outage shows as `smtp: down` while `status` stays `ok`. Alert on the check itself if mail matters to you.
- nodemailer is pinned to 10.3.1 (D36); newer 10.x releases exist.

## Errors
- The pg pool has no `connectionTimeoutMillis`, so with Postgres unreachable but not refusing connections (a dropped network rather than a stopped server), a query can wait on the OS timeout instead of failing fast as a 503. To set in C9, where "DB down → 503, not 401" is tested.
- A body sent to a route that doesn't exist is still parsed first, so malformed JSON to a missing route answers `400 invalid_json`, not `404`.
- `text/plain` bodies are still accepted by Fastify's built-in parser and then fail DTO validation (`400`), rather than being refused with `415`.

## Testing
- `configure-app.ts` is covered only by e2e tests, not by unit coverage.
- `*.entity.ts` files are excluded from unit coverage (D16). They are checked by `test/schema.e2e-spec.ts` and `migration:check` instead.
