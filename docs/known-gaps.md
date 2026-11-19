# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear. For the overall build order, see `docs/roadmap.md`.

## Database
- The schema covers Part 1, rate-limit counters (C5), user-list indexes (C12), the photo-reference index (C13) and the `transformations` history (C15). Its storage columns (C19, D79) are in place.
- `POSTGRES_MIGRATIONS_RUN=false` by default, so a deploy must run `npm run migration:run` (or set the flag) itself. CI and `npm run test:e2e` migrate their own database.
- `grants.all_actions = true` should mean "no `grant_actions` rows". That spans two tables, so the admin service never writes such rows and a snapshot reload refuses them (D45); a direct SQL change could still create one, and protected routes would then answer 503 until it is fixed.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **The client half of spec 1.3 §1.3.3** (one shared refresh after a `401`, a single retry, clearing state) belongs to a frontend this project doesn't have (D48). The server guarantees what it relies on: a guard `401` always comes before the handler.
- Every rate-limit policy is wired to its route or flow.

## User reads, updates and storage (C12–C13)
- S3 and single-instance development/test storage support reads, writes, deletes and listing. Uploads normalize JPEG/PNG/WebP to bounded metadata-free WebP; readers trust that write boundary rather than re-encoding every read. Production rejects local storage. Profile/list responses need no storage access.
- AWS credentials currently use the explicitly validated local configuration. Workload-role/temporary-credential integration and bucket-version purging are not implemented. Use a private, unversioned bucket/prefix; see `docs/storage-setup.md`. CI needs no real AWS credentials.
- Workers must use the same reference database as the configured bucket/prefix. Isolated smoke tests disable automatic workers and remove only their own objects. Reconciliation is bounded, retains listing progress in memory, and may be delayed by continuous uploads while its exclusive advisory lock is unavailable; restarting an instance restarts its scan.
- Cleanup holds its job row lock, and the orphan sweep its exclusive adoption lock, through bounded storage calls (D53). Slow S3 lengthens those transactions and briefly delays uploads; moving the I/O out of the transaction would need a lease (D64).
- A stream failure before response bytes produces a safe 503; after bytes are sent, the connection is aborted. It cannot become a JSON error envelope after streaming starts. The storage error/path is never propagated.
- List queries warn at 500 ms and are cancelled by Postgres at 2 seconds. Automatic EXPLAIN/production plan monitoring is not configured; composite range and prefix indexes are supplied by the migration.

## User deletion (C14)
- The last-manager check runs for every deletion target, not only `rbac@manage` holders. The result is identical while any active holder exists, which the API guarantees (D78).
- A self confirmation with a malformed key, or a key that has no job yet, runs the full chain before validation, so its 400 comes after 401/403 (D57). A replay with a valid key skips the chain.
- Anonymization doesn't touch `rate_limits` rows: their keys are HMACs of the user id, never the id itself, and they expire with their window.
- A `failed` job stays failed until an admin repeats `DELETE`; nothing alerts on it. Watch `deletion_job_failed` events.
- Each process runs one worker loop (every 5 s, up to 10 jobs). Several instances share the queue safely through `SKIP LOCKED` and the attempt fence (D60).
- The lease isn't renewed while erasers run. Each eraser must stay well under `DELETION_WORKER_LEASE_SECONDS`; an overlapping second run can't change anything (attempt fence) but uses up a start (D64).
- The confirm route's replay lookup (one primary-key read) runs before CSRF and IP limits (D64).

## Transformations (C15)
- **Endpoints:** text (C16), image (C17), history (C18), saving and downloads (C19) are live.
- A worker thread has no `resourceLimits`: a library that allocates far more than its input is bounded by its timeout and the output limit, not by a memory cap. Native allocations (sharp, resvg) aren't covered by V8 limits anyway; C17 sets the libraries' own pixel limits.
- The timeout includes time queued behind other conversions (D67). With `TRANSFORMATION_WORKER_THREADS=2`, more than two slow conversions at once can 504 sooner than their own work would.
- The result's name is removed as soon as it is opened (POSIX semantics, D68). A Windows host would need a different cleanup.
- A database without a `user` role (a fresh deployment, or an un-bootstrapped dev database) reports `transformations: down`, so `/health/ready` is 503 until RBAC is bootstrapped; the seed waits for that start (D66). Liveness and the Docker `HEALTHCHECK` are unaffected.

## Text conversion (C16)
- CSV output doesn't neutralise spreadsheet formulas (a cell starting with `=`, `+`, `-` or `@`); the spec asks for faithful conversion, and the result is a download, not a rendered page.
- Unknown XML entities (`&foo;`) are kept as literal text rather than refused; only the five predefined ones are decoded.
- Each conversion holds its whole input and result in memory in one worker thread: at most a 10 MiB input and a 50 MiB result per conversion, times `TRANSFORMATION_WORKER_THREADS`.
- During C16's gate, `users-read.e2e-spec.ts` (C12) failed once, right after a run in which the host stalled for several minutes. It passed in the 16 full runs that followed and couldn't be reproduced. Its timing-sensitive tests (the 2-second SQL timeout, the lock-wait check) are the likely cause.

## Image conversion (C17)
- The conversion log carries the image's final width × height (closed in C19, D79).
- **Text in SVGs:** the Alpine image ships no system fonts, so resvg draws no text. Shapes, paths and gradients render; `<text>` doesn't. Installing a font package in the Dockerfile would fix it.
- `data:` URIs inside SVGs are refused (D74), so an SVG that embeds a bitmap as a data URI can't be converted.
- The SVG check is structural (elements, attributes, `url()`, `@import`). CSS escape tricks could in principle hide a `url()` from it; resvg never fetches anything and every external reference is refused, so this is defence in depth.
- resvg can't be interrupted mid-render, so an expensive SVG within the pixel limit runs to completion even past the timeout. The thread is then terminated, and the client still gets 504.

## Transformation history (C18)
- A cursor is valid until its row is deleted (retention or user deletion). After that it still continues correctly from its position: keyset paging doesn't need the row to exist.
- Retention runs per instance; several instances may sweep at once, which is safe (each DELETE takes its own rows) but redundant.

## Saved results (C19)
- **The pending copy is local to one instance.** `save=true` copies the result to `<TRANSFORMATION_TEMP_DIR>/pending/<key>`; the worker on another instance would not find it and would mark the save `error`. Run one instance, or point every instance at a shared `TRANSFORMATION_TEMP_DIR` (D79).
- The port reports only `unavailable`, so a temporary and a permanent storage failure look the same: five failed writes (30 s, 60 s, 2 min, 4 min between them) turn a `pending` save into `error`. A longer outage loses the save, not the conversion.
- The worker and the retention sweep hold a row lock through a bounded storage call, like the photo cleanup (D64). Slow storage lengthens those transactions.
- A whole result is read into memory for each write (`ObjectStorage.write` takes a Buffer): up to the direction's output limit, one at a time per worker pass.
- A local-storage leftover under a stored key with a different size (a crash mid-write) is never overwritten, so that save ends as `error` after its attempts. S3 has no such state.
- When a stored file expires before its row, the row goes back to `not_requested` (the enum has no "expired"); with the defaults rows are deleted first (D79).
- Downloads have no rate limit (spec 2.4 names none).
- History retention is off when `STORAGE_WORKERS_ENABLED=false` (the flag exists for isolated smoke tests, D53); leave it on in any real deployment.
- The eraser walks all of a user's rows in one run, so a user with thousands of saved results can outlast `DELETION_WORKER_LEASE_SECONDS` (D64); a second run is fenced and retries.
- An `error` row keeps its key so cleanup can still try the object; if storage stays down, the object outlives its row's retention attempt until the next sweep succeeds.

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
- **Validation failures (400) on admin routes are logged by the error filter, not as `rbac_change` events;** refusals the service decides (404, 409, a 400 for a foreign action) are.
- **Bootstrap vs. a concurrent activation on another instance:** a user activated by a second instance while the first one's bootstrap transaction is open can end up with no role (neither the insert nor the backfill sees the other). Give them `user` through `PUT /admin/rbac/users/{id}/roles` (D47).
- **Before the bootstrap there is no `user` role,** so an activation assigns nothing; the bootstrap then gives `user` to every active user without roles.

## Authentication
- **Sessions are stateless (spec 1.2):** a refresh token can't be revoked before its 30-day `exp`, and reuse after rotation isn't detected. Blocking or deleting the user is the only way to end a session early, because every token is checked against the user's current status.
- **Key rotation:** `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are single keys. Changing one signs everyone out of that kind of token; there is no key ring like the user-list cursor has.

## Email challenges
- `resend_cooldown` is a 429 like the spec says; email change and deletion reserve their five-emails/hour quotas in the challenge transaction.

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
