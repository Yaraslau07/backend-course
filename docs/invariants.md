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
- Profile PATCH, photo replacement and clearing edit only `active`/`blocked` targets. Direct email/status needs `users@update_any` even for self; self email challenges remain self-only. No-op normalized writes leave `updated_at` unchanged.
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
- All of this is `ChallengeEngine` (D38): the flow locks the user, the engine locks the challenge, refusals come back as an `Outcome` so counted attempts commit.
- Mail goes through `MailService.sendChallenge()` (2 s limit). A failure is `MailUnavailableError` (a 503); flows catch it to add the safe fields below (D33).
- Commit **before** SMTP. If SMTP fails after the commit, return `503` with `confirmationRequired`, `method`, the id and `retryAfterSeconds`, and keep the challenge. The secret is never in a response.
- Responses: `202 { confirmationRequired: true, method, attemptId|challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 }`.
- Use claim-then-act for single-use consumption: a conditional `UPDATE … WHERE consumed_at IS NULL`, then check `affected`.

## Authorization chain (every protected route)

access cookie → current user is `active` → CSRF (cross-origin writes) → IP and user rate limits → RBAC `permission@action` → (in the handler) `Ownership.selfOr` before the lookup → load resource → `Ownership.assertOwner` → business logic (D48).

- Every route declares one of: `@Public()`; `@Internal()` (readiness only); exactly one `@RequirePermission(permission, action)`, optionally with one `@Replay(name)` (an idempotent retry answered before the chain, D57); `@Receipt(header)`, optionally with one pair. A missing or conflicting declaration, or a name that fails the RBAC pattern, fails readiness (`route_declarations`), and the route answers `503 authorization_unavailable` without running (D23, D24).
- A receipt route with the header present runs the handler, which checks the receipt; the cookie is not read. Without the header it follows the pair's chain, or answers `401 invalid_session` if it has no pair (D26).
- CSRF (D27, D28): a write (`POST`, `PUT`, `PATCH`, `DELETE`) with an `Origin` other than the API's own needs that exact origin in `CORS_ORIGINS` and `X-CSRF-Protection: 1`, else `403 csrf_rejected`. No `Origin` passes (not a browser) unless `Sec-Fetch-Site` is `cross-site` or `same-site`. Public writes are checked in the route guard; protected ones after the active-user step.
- The permission check comes **before** looking up the target. Without the right you get `403`, never `404`.
- C12 follows the author's clarification (D51): the shared guard runs before profile-ID validation, and UUID case does not change ownership. The profile ID accepts 1–128 ASCII letters, digits, `_` and `-`; a valid non-UUID is an absent target, not a database cast error. User-list query validation follows `users@list`.
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
| 400 | `invalid_file` | a conversion input is damaged, unsafe or doesn't fit the target (D68) |
| 400 | `invalid_challenge` | challenge not found, expired, wrong secret, replaced, confirmed or consumed as `user_inactive` |
| 409 | `email_taken` | registration of an email that exists, `pending` included |
| 409 | `challenge_conflict` | challenge consumed as `admin_override`, `email_conflict` or `job_exists` |
| 409 | `name_taken` | RBAC role or permission name exists |
| 409 | `grant_exists` | a second grant for the same role and permission |
| 409 | `resource_in_use` | RBAC: deleting a role with grants or users, a granted permission, or an action a grant lists |
| 409 | `last_rbac_manager` | the change would leave no active user with `rbac@manage` |
| 409 | `idempotency_conflict` | an `Idempotency-Key` already names a job for a different target |
| 409 | `deletion_exists` | a deletion challenge is started or resent after the job exists |
| 429 | `attempts_exhausted` | the 5th wrong OTP already consumed the challenge |
| 429 | `resend_cooldown` | a new email within 60 s of the last send (`retryAfterSeconds`) |
| 409 | `file_not_ready` | download while `storageStatus=pending` |
| 503 | `authorization_unavailable` | user DB, RBAC snapshot or route config unavailable |

Generic codes, used when nothing more specific applies:

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request`, `validation_failed`, `invalid_json` | malformed request; failed DTO validation (with `errors: [{ field, rules }]`); unparsable JSON |
| 401 | `invalid_session` | also any stray 401 |
| 403 | `forbidden` | a plain 403 that isn't one of the specific ones |
| 404 | `not_found` | missing resource or route |
| 405, 408, 422 | `method_not_allowed`, `request_timeout`, `unprocessable_entity` | any other 4xx becomes `400 bad_request`, so a code always means one status (D37) |
| 409 | `conflict` | includes an unhandled unique violation (`23505`) |
| 413, 415 | `payload_too_large`, `unsupported_media_type` | |
| 429 | `too_many_requests` | sets `Retry-After` when `retryAfterSeconds` is given |
| 500 | `internal_error` | anything unexpected |
| 503 | `service_unavailable` | database unreachable, timed out, deadlocked or shutting down |
| 504 | `gateway_timeout` | a conversion ran out of time (Part 2) |

Error body shape: `{ statusCode, code, message, requestId }`, plus spec-mandated safe extras (`retryAfterSeconds`, `confirmationRequired`, `method`, `attemptId`, `challengeId`, `errors`). The full list lives in `src/core/errors/error-catalogue.ts`; the allowed extras are the `ErrorExtras` type. Throw `new AppException(code, extras?)`; the code fixes the status.

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
- Every request has a `requestId` (UUID, echoed in `X-Request-Id`). The request log names the matched route pattern (`/users/:userId`), never the concrete path (D49).
- 401, 403 and 503 log a category: `missing`, `malformed`, `signature`, `expired`, `claims`, `token_use`, `user_inactive`; `permission_denied`, `ownership_denied`, `csrf_rejected`; `users`, `rbac_version`, `rbac_snapshot`, `route_configuration`.

## Keys (all different, each ≥ 32 random bytes, base64url)

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `REGISTRATION_CHALLENGE_HMAC_KEY`, `LOGIN_CHALLENGE_HMAC_KEY`, `EMAIL_CHANGE_HMAC_KEY`, `DELETION_CHALLENGE_HMAC_KEY`, `LOG_PSEUDONYM_HMAC_KEY`, `RATE_LIMIT_KEY_HMAC_KEY`, and every key in `USER_LIST_CURSOR_HMAC_KEYS`. Validated at boot (`src/core/config/config.validation.ts`). HMAC inputs use domain prefixes (for example `users-list-cursor`, `users-list-query`).

## Rate limits

- Every limit is a named policy in `src/core/rate-limit/rate-limit.policies.ts`, with its spec section. Exceeding one is `429 too_many_requests` with `retryAfterSeconds` and `Retry-After`.
- Windows slide: at most N allowed hits in any window. Refused requests don't count (D29).
- IP-keyed policies go on routes with `@RateLimit()`; user-keyed ones only on `@RequirePermission` routes; custom ones (email + IP, emails sent, self vs. foreign) are applied in code with `RateLimiter` (D32). Failure-only limits `consume()` before the attempt and `release()` on success, so concurrent attempts can't exceed the limit (D37).
- Stored keys are HMACs; the `rate_limits` table never holds an IP, email or id (D31).

## Cookies

- `access_token`: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`, no `Domain`.
- `refresh_token`: `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=2592000`, no `Domain`.
- For a cross-site frontend: `SameSite=None; Secure`, switched on with `COOKIE_SAME_SITE=none` (D42). Tokens never appear in a body, a JS-readable header or a URL.
- JWT: HS256 only, separate secrets, claims `sub iss aud iat exp token_use`, 30 s clock tolerance, no `jti`, roles or PII.

## Background work

No external broker: jobs are DB rows claimed with `UPDATE … RETURNING` (or `FOR UPDATE SKIP LOCKED`) under a lease. Every eraser and storage delete is idempotent, and `not_found` counts as success.

Conversions (C15) are not jobs: they run in a worker-thread pool while the request waits, and a converter past its timeout has its thread terminated (D67).

Deletion (C14) claims one `queued` or lease-expired `running` job at a time, sets a lease and counts the start, runs every registered eraser, and fences each later write by the claimed `attempts` (D60). Every module that stores user data is listed in `USER_DATA_OWNERS` and registers an eraser, or readiness fails (D61).

Storage cleanup (C13) uses a transaction-held `SKIP LOCKED` row lock through the bounded delete instead of a persisted lease/running state. Reconciliation checks the same database's photo references and coordinates with pending adoption using a shared/exclusive transaction advisory lock (D53). Never pair automatic reconciliation with a temporary/unrelated reference database.
