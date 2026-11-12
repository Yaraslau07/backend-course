# Cross-cutting invariants

Rules that span several lessons. Every feature must follow them. They are distilled from `docs/specs/*`; if this file and a spec disagree, **the spec wins**, and this file gets fixed.

## User statuses

| Status | Authenticates? | Set by |
|---|---|---|
| `pending` | no | registration with confirmation |
| `active` | **yes, the only one** | registration (no confirmation) or confirm; admin PATCH |
| `blocked` | no | admin PATCH |
| `deleting` | no | deletion accepted (immediate barrier) |
| `deleted` | no | deletion worker after anonymization |

- Every token (access and refresh) is accepted only for an existing `active` user, checked against the DB on each request.
- Login gives one `401 invalid_credentials` for: unknown email, wrong password, any status other than `active`.
- An access or refresh failure gives one `401 invalid_session`. The DB being down gives `503`, never `401`.
- Only an `active` user counts as a holder of `rbac@manage`. No operation may leave zero such users; that is a `409`.

## Lock order (deadlock prevention)

Every transaction that touches more than one of these locks them **in this order**, with `SELECT … FOR UPDATE`:

1. `rbac_policy_state` (the shared RBAC invariant lock: role assignments, blocking, deletion)
2. `users` row
3. challenge row (registration, login, email change, deletion)
4. job row (`deletion_jobs`, `storage_cleanup_jobs`)

Transactions are explicit (`dataSource.transaction(async (manager) => …)`); no ambient `@Transactional()`.

## Email challenges (registration, login, email change, deletion)

Shared semantics. Each scenario has **its own HMAC key**.

- Secret: an OTP (6 digits) or a magic-link token (32 random bytes, base64url). Stored only as HMAC-SHA256 with the scenario key; compared in constant time.
- Magic link format: `attemptId.secret` (registration uses the token alone, found by its HMAC). Sent in the URL **fragment**. The link `GET` never changes state; a `POST` does.
- TTL: `last_sent_at + 10 minutes`. An expired challenge does not increment `attempts`.
- OTP attempts: 5. **The 5th attempt is still checked** and can succeed. A wrong 5th gives `400` and consumes the challenge as `attempts_exhausted`; the next request gives `429`. Magic links have no counter.
- Resend: at most once per 60 s from `last_sent_at` (`429` with the remaining seconds). It replaces `secret_hash`, resets `attempts` and restarts the TTL; the old secret stops working.
- One outstanding challenge per user per scenario (partial unique index). A new one consumes the old as `replaced`.
- `consumed_reason`: `confirmed`, `replaced`, `attempts_exhausted`, `user_inactive`, `admin_override`, `email_conflict`, `job_exists`.
- Commit **before** SMTP. If SMTP fails after the commit, return `503` with `confirmationRequired`, `method`, the id and `retryAfterSeconds`, and keep the challenge. The secret is never in a response.
- Responses: `202 { confirmationRequired: true, method, attemptId|challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 }`.
- Use claim-then-act for single-use consumption: a conditional `UPDATE … WHERE consumed_at IS NULL`, then check `affected`.

## Authorization chain (every protected route)

access cookie → current user is `active` → CSRF (cross-origin writes) → RBAC `permission@action` → load resource → ownership → handler.

- Every route declares one of: public; exactly one `permission@action`; a receipt header (optionally with one pair). A missing or conflicting declaration fails readiness.
- The permission check comes **before** looking up the target. Without the right you get `403`, never `404`.
- Roles in a JWT, body, query or header are ignored. RBAC reads the current snapshot; if the snapshot version is stale or it is unavailable, return `503 authorization_unavailable`.

## Error codes catalogue

| Status | `code` | When |
|---|---|---|
| 401 | `invalid_credentials` | login: unknown email, wrong password, non-active |
| 401 | `invalid_session` | access or refresh missing, invalid, expired, wrong type; user absent or non-active |
| 403 | `permission_denied` | RBAC refused |
| 403 | `ownership_denied` | allowed type, not your resource |
| 403 | `csrf_rejected` | cross-origin write without an exact Origin and `X-CSRF-Protection: 1` |
| 403 | `self_confirmation_required` | admin `DELETE /users/{own id}` |
| 400 | `invalid_cursor` | any cursor problem, no details |
| 409 | `file_not_ready` | download while `storageStatus=pending` |
| 503 | `authorization_unavailable` | user DB, RBAC snapshot or route config unavailable |

Error body shape: `{ statusCode, code, message, requestId }`, plus spec-mandated safe extras (`retryAfterSeconds`, `attemptId`, `method`, …). This arrives in Phase 1.

## Canonical safe profile (7 fields, always this shape)

`id`, `email` (normalized, never masked), `displayName | null`, `photoUrl | null`, `status`, `createdAt`, `updatedAt` (RFC 3339 UTC).

- `photoUrl` is `null` for no photo, `deleting` and `deleted`. Otherwise it is `PUBLIC_API_BASE_URL/users/{id}/photo`, never a storage key.
- It never includes `password_hash`, challenge secrets, HMACs, JWTs, cookies, roles, `photo_key` or internal fields.

## Normalization

- Email: trim, then lowercase; `+tag` is kept; at most 254 characters.
- Password: never trimmed or normalized. At least 8 characters, at least one letter (any alphabet) and one digit. Over-long input is **rejected**, never truncated (argon2 has no 72-byte cut, but keep an explicit max).
- `displayName`: trim Unicode whitespace, NFC, 1–80 code points, no U+0000–U+001F or U+007F–U+009F; `null` clears it.
- RBAC names and actions: trim, lowercase, `^[a-z][a-z0-9._-]{0,63}$`.

## Logging (never log)

email (cleartext), password, password hash, OTP, magic-link token, HMAC, JWT, `Cookie` / `Set-Cookie`, keys, full URL or query string, full request body, full headers, `displayName`, `photo_key` or storage keys, file contents, the cursor payload, `q`, tombstone, and (for deletion events) `jobId` and the user ids.

- An unknown email on login is logged as `pseudonymize(email)` (HMAC with `LOG_PSEUDONYM_HMAC_KEY`).
- JWT failure categories: `missing`, `malformed`, `signature`, `expired`, `claims`, `token_use`, `user_inactive`.
- Every request has a `requestId` (UUID, echoed in `X-Request-Id`).

## Keys (all different, each ≥ 32 random bytes, base64url)

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `REGISTRATION_CHALLENGE_HMAC_KEY`, `LOGIN_CHALLENGE_HMAC_KEY`, `EMAIL_CHANGE_HMAC_KEY`, `DELETION_CHALLENGE_HMAC_KEY`, `LOG_PSEUDONYM_HMAC_KEY`, and every key in `USER_LIST_CURSOR_HMAC_KEYS`. Validated at boot (`src/core/config/config.validation.ts`). HMAC inputs use domain prefixes (for example `users-list-cursor`, `users-list-query`).

## Cookies

- `access_token`: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`, no `Domain`.
- `refresh_token`: `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=2592000`, no `Domain`.
- For a cross-site frontend: `SameSite=None; Secure`. Tokens never appear in a body, a JS-readable header or a URL.
- JWT: HS256 only, separate secrets, claims `sub iss aud iat exp token_use`, 30 s clock tolerance, no `jti`, roles or PII.

## Background work

No external broker: jobs are DB rows claimed with `UPDATE … RETURNING` (or `FOR UPDATE SKIP LOCKED`) under a lease. Every eraser and storage delete is idempotent, and `not_found` counts as success.
