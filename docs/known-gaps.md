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
- **CSRF guard:** exact `Origin` plus `X-CSRF-Protection: 1` on cross-origin writes, `403 csrf_rejected`. CORS already allows the header.
- **Throttling:** `@nestjs/throttler` is installed but not wired (see D11). This needs per-route limits and an email+IP failure counter, and `TRUST_PROXY` has to be set correctly wherever IP-based limits matter.
- **MailService:** nodemailer transport with a 2 s timeout, templates, and an `smtp` readiness check.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres and `POSTGRES_MIGRATIONS_RUN=true`, then checks the schema exists.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Harmless today. When native deps arrive (argon2, sharp), approve their scripts with `npm install-scripts approve <pkg>`, and check that the Dockerfile's `npm ci --ignore-scripts` still gets prebuilt binaries.

## Route declarations
- The startup scan reports only the first path of a controller or handler that declares several aliases (`@Controller(['a', 'b'])`). The declaration applies to every alias anyway, since it sits on the handler.

## Errors
- The pg pool has no `connectionTimeoutMillis`, so with Postgres unreachable but not refusing connections (a dropped network rather than a stopped server), a query can wait on the OS timeout instead of failing fast as a 503. To set in C9, where "DB down → 503, not 401" is tested.
- A body sent to a route that doesn't exist is still parsed first, so malformed JSON to a missing route answers `400 invalid_json`, not `404`.
- `text/plain` bodies are still accepted by Fastify's built-in parser and then fail DTO validation (`400`), rather than being refused with `415`.

## Testing
- `configure-app.ts` is covered only by e2e tests, not by unit coverage.
- `*.entity.ts` files are excluded from unit coverage (D16). They are checked by `test/schema.e2e-spec.ts` and `migration:check` instead.
