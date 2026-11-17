# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear. For the overall build order, see `docs/roadmap.md`.

## Database
- The schema covers Part 1, rate-limit counters (C5), user-list indexes (C12), and the photo-reference index (C13). The `transformations` table still needs its own migration (C15).
- `POSTGRES_MIGRATIONS_RUN=false` by default, so a deploy must run `npm run migration:run` (or set the flag) itself. CI and `npm run test:e2e` migrate their own database.
- `grants.all_actions = true` should mean "no `grant_actions` rows". That spans two tables, so the admin service never writes such rows and a snapshot reload refuses them (D45); a direct SQL change could still create one, and protected routes would then answer 503 until it is fixed.
- `ck_deletion_jobs_attempts` caps starts at 5. The deletion worker's claim (C14) must move an expired `running` job with 5 attempts to `failed`; a plain `attempts + 1` on it would violate the constraint.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **The client half of spec 1.3 §1.3.3** (one shared refresh after a `401`, a single retry, clearing state) belongs to a frontend this project doesn't have (D48). The server guarantees what it relies on: a guard `401` always comes before the handler.
- **Rate limits are partly unused:** registration, login, refresh, user reads/listing, updates and email changes are wired; deletion and history policies arrive with their routes.

## User reads, updates and storage (C12–C13)
- S3 and single-instance development/test storage support reads, writes, deletes and listing. Uploads normalize JPEG/PNG/WebP to bounded metadata-free WebP; readers trust that write boundary rather than re-encoding every read. Production rejects local storage. Profile/list responses need no storage access.
- AWS credentials currently use the explicitly validated local configuration. Workload-role/temporary-credential integration and bucket-version purging are not implemented. Use a private, unversioned bucket/prefix; see `docs/storage-setup.md`. CI needs no real AWS credentials.
- Workers must use the same reference database as the configured bucket/prefix. Isolated smoke tests disable automatic workers and remove only their own objects. Reconciliation is bounded, retains listing progress in memory, and may be delayed by continuous uploads while its exclusive advisory lock is unavailable; restarting an instance restarts its scan.
- A stream failure before response bytes produces a safe 503; after bytes are sent, the connection is aborted. It cannot become a JSON error envelope after streaming starts. The storage error/path is never propagated.
- List queries warn at 500 ms and are cancelled by Postgres at 2 seconds. Automatic EXPLAIN/production plan monitoring is not configured; composite range and prefix indexes are supplied by the migration.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres and `POSTGRES_MIGRATIONS_RUN=true`, then checks the schema exists.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Argon2 and sharp use prebuilt optional packages without install scripts. C13 installed with `--ignore-scripts` and exercised native image conversion; CI also builds/boots the Node 22 Alpine image with scripts disabled.

## Route declarations
- The startup scan reports only the first path of a controller or handler that declares several aliases (`@Controller(['a', 'b'])`). The declaration applies to every alias anyway, since it sits on the handler.

## Rate limits
- `TRUST_PROXY` must be `true` behind a reverse proxy, or every client shares the proxy's IP budget. It must stay `false` when the app is reachable directly, or a client can pick its own IP with `X-Forwarded-For`.

## RBAC
- **Deletion (C14) must wire the last-holder check.** Blocking (C13) now takes the policy lock before the user lock and runs the shared invariant before committing. Only active users count as `rbac@manage` holders.
- **Validation failures (400) on admin routes are logged by the error filter, not as `rbac_change` events;** refusals the service decides (404, 409, a 400 for a foreign action) are.
- **Bootstrap vs. a concurrent activation on another instance:** a user activated by a second instance while the first one's bootstrap transaction is open can end up with no role (neither the insert nor the backfill sees the other). Give them `user` through `PUT /admin/rbac/users/{id}/roles` (D47).
- **Before the bootstrap there is no `user` role,** so an activation assigns nothing; the bootstrap then gives `user` to every active user without roles.

## Authentication
- **Sessions are stateless (spec 1.2):** a refresh token can't be revoked before its 30-day `exp`, and reuse after rotation isn't detected. Blocking or deleting the user is the only way to end a session early, because every token is checked against the user's current status.
- **Key rotation:** `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are single keys. Changing one signs everyone out of that kind of token; there is no key ring like the user-list cursor has.

## Email challenges
- Registration, login and email change use the engine; deletion (C14) wires it in next.
- `resend_cooldown` is a 429 like the spec says; email change reserves its five-emails/hour quota in the challenge transaction. The deletion flow must apply `deletion_challenge_emails` when it arrives.

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
