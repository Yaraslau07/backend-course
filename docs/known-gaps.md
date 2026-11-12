# Known gaps

A running list of what's still outstanding. Check it before assuming something is unhandled, and update it as gaps close or new ones appear.

## Next: database schema (right after Phase 0)
- No entities or migrations exist yet. Design the Part 1 schema in one initial migration:
  - users (with the status enum and the deleted-state CHECK constraint)
  - the four challenge tables, with partial unique indexes for "one outstanding per user"
  - roles, permissions, permission_actions, grants, grant_actions, user_roles, rbac_policy_state
  - deletion_jobs, storage_cleanup_jobs
- `POSTGRES_MIGRATIONS_RUN=false` by default; CI runs `npm run migration:run` before e2e.

## Phase 1 framework pieces (deliberately not in Phase 0)
- **Route declarations:** `@Public()`, `@RequirePermission(permission, action)`, `@Receipt(header)`, plus a startup scan registered as a readiness check. Until then, **no route is protected**. When it lands, `GET /health/live` gets `@Public()` and `GET /health/ready` an internal marker.
- **Error envelope:** a global filter producing `{ statusCode, code, message, requestId }` and mapping Postgres `23505` to `409`. Today errors use Nest's default body.
- **CSRF guard:** exact `Origin` plus `X-CSRF-Protection: 1` on cross-origin writes, `403 csrf_rejected`. CORS already allows the header.
- **Throttling:** `@nestjs/throttler` is installed but not wired (see D11). This needs per-route limits and an email+IP failure counter, and `TRUST_PROXY` has to be set correctly wherever IP-based limits matter.
- **MailService:** nodemailer transport with a 2 s timeout, templates, and an `smtp` readiness check.

## Infrastructure
- No CD. The course only requires a service called through an HTTP client.
- Readiness is gated by source IP, not a separate internal port (see D6).
- The Docker smoke test in CI starts the container with a throwaway Postgres; it doesn't run migrations, since there are none yet.
- `npm install` prints `install-scripts` warnings for packages whose postinstall was blocked by npm's allowlist (`unrs-resolver`). Harmless today. When native deps arrive (argon2, sharp), approve their scripts with `npm install-scripts approve <pkg>`, and check that the Dockerfile's `npm ci --ignore-scripts` still gets prebuilt binaries.

## Testing
- `configure-app.ts` is covered only by e2e tests, not by unit coverage.
