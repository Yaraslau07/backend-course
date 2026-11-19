# Assignment: Backend Course · Group A1

This file combines the course introduction and overall goal (from `0.0 Introduction.md`) with the full practical task of every lesson (1.0–2.4), copied verbatim. Lessons 0.1–0.6 contain theory only and have no practical task.

---

# Frontend Department / Backend Course / Group A1

## What is the course about?

This backend course helps frontend developers build skills that meet current market needs and develop a T-shaped profile: broad knowledge supported by deep expertise in a core area.

> All participants work on the same assignment, ***but any part of it may be adjusted individually in agreement with their mentor.***
>

## Tools

You may use any tools, including AI, at every implementation stage. You must be prepared to explain and justify every technical decision during interim and final reviews with your mentor. Agree with your mentor before choosing tools that differ from those recommended in the assignment.

## Mentors

Each participant is assigned a mentor based on their level of training and location.
The mentor checks progress on the practical assignment every week.

> ***You can contact your mentor for theoretical or technical advice at any stage of the course.*** Contact your mentor and schedule a calendar meeting to arrange a consultation.
If you share an office with your mentor, you can also ask them in person without scheduling a meeting.
> 

### Final result

By the end of the course, you will have built a backend service: a monolithic HTTP API with a relational database, access checks, and background tasks. All scenarios run through an HTTP client; a separate frontend is not required.

The service registers users, optionally verifies their email, logs them in using access and refresh cookies, manages roles and permissions, and authorizes protected operations. Users can view and update their profiles and delete their accounts. Administrators manage the user list, roles, and other users’ profiles. The same service transforms text files and images, provides operation history, and optionally saves results to object storage.

### Resources

#### Node.js

> Boilerplate for starting a new monolithic project on NestJS.
> Contains basic modules and connections.
> [https://github.com/pavel-skripko-innowise/nestjs-monolith-boilerplate](https://github.com/pavel-skripko-innowise/nestjs-monolith-boilerplate)

#### .NET

> Project template for starting a monolithic Web API on .NET Core.
> Contains a basic API endpoint `/health`, which verifies that the service is running.
> OpenAPI is enabled in the Development environment.
> Currently the template only provides an OpenAPI document; the Swagger UI is not included.
> The test project uses xUnit and verifies that a GET request to `/health` returns 200 OK.
> [https://github.com/pavel-skripko-innowise/dotnet-minimal-webapi-boilerplate/](https://github.com/pavel-skripko-innowise/dotnet-minimal-webapi-boilerplate/)


---

# 1.0 Registration — Practical task

_Source: [1.0 Registration.md](<1.0 Registration.md#practical-task>)_

User registration functionality in the system.
The guest creates an account using email and password. If confirmation is disabled, the account is active immediately, and if enabled, it waits for a code from an email or click on a link. The confirmation method is chosen by the server. The password is stored only as a slow hash; repeated registration to the same email is prohibited.

## 1) Registration



### 1.1 General

**Purpose:** create a user account using email and password.

**Users/roles:** guest (unauthenticated user).

**Dependencies/related settings:** confirmation email for registration is enabled by a separate flag for the “registration” script. While there is no settings module, the flag is set in the application configuration. Login confirmation sets its own authentication module flag and does not affect registration.

The session is created by the authentication module; registration itself does not issue tokens. The role `user` is assigned to RBAC in the same transaction where the user becomes `active`. While the RBAC module is not connected, registration does not create a role: already active users will receive it the first time they load an empty RBAC configuration.

### 1.2 User stories

1. **Registration without confirmation:** the user enters an email and password, the account immediately becomes active and suitable for login. The login itself is not performed.
2. **Registration with confirmation:** the user enters an email and password, and then confirms with an email code (OTP) or via a link (magic link). Which of the two methods is used is determined by the server configuration.



### 1.3 Contract



#### 1.3.1 Registration request


| `POST /auth/register` |Checks/validation|
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email: string`       |Required, valid format. Before comparison and writing, outer spaces are trimmed and emails are converted to lowercase. `user+tag@example.com` is a separate address. Repeated registration for an existing `email` is prohibited. This also applies to an account that is still awaiting confirmation.|
| `password: string`    |Required. The leading spaces in the password are preserved. Password policy: from 8 characters, at least one email of any alphabet and one number. A password that is too long is rejected by the check: the algorithm should not silently cut off the tail.|


**Logic/steps:**

1. Accept `email`, `password`.
2. Check the validity of the input data.
3. Calculate a slow password hash with a separate salt for each password. It is impossible to recover a password from a hash. The salt is included in the summary line, so there is no need for a separate field for it.
4. If registration confirmation is disabled, create a user in the active state and, if the RBAC module is connected, assign the role `user` in the same transaction.
5. If registration confirmation is enabled, create a user in the `pending` state without a role, save the confirmation challenge and send an email using the selected method:
    - code (OTP), or
    - link (magic link).

The flag only affects new registrations. If it was turned off after registration, the created entry `pending` itself will not become active. It is still completed by confirmation or resend.

If the email is not sent, the entry `pending` and the attempt are saved. Repeated `register` to this email will return an email-already-in-use error, and the email can only be delivered again by resending.

The uniqueness of the email is ensured by a restriction in the database. A conflict on this limit is returned as a normal re-registration error and should not result in an unhandled server crash.

**Answers:**

- **Confirmation disabled:** **201 Created**, `id`, normalized `email`, `status: active`. The password, hash and tokens are not included in the response.
- **Acknowledgment included:** **202 Accepted**, `confirmationRequired: true`, `method` (`otp` or `magic_link`), `attemptId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`. The code and link token are transmitted only in the email and are not included in the response.



#### 1.3.2 Registration confirmation vian email

**General rule:** a new user is confirmed only if the “registration” scenario flag was enabled at the time of registration. An challenge that has already been issued can be confirmed or resubmitted regardless of whether the flag is currently enabled.


| `POST /auth/register/confirm`               |Options|
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|Code (OTP): `challenge identifier` + `code`|Length: 6 digits. TTL: 10 minutes. Limit of input attempts: 5. The fifth attempt may still be successful. The fifth incorrect entry returns an incorrect-code error and consumes the challenge. The next request, even with the correct code, is rejected as exceeding the limit.|
|Magic link: `token`|32 random bytes. The challenge is found by the HMAC token, the identifier is not included in it. TTL: 10 minutes. The token is one-time use. The account is activated by `POST` with a token. Opening a link in itself does not change the status.|



| `POST /auth/register/resend` |Options|
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`                      |No more than once every 60 seconds. For a code, the new email replaces the previous code, restarts the TTL and resets the retry counter. The old code is no longer suitable. For a link, a new email replaces the previous link, restarts the TTL and consumes the old token.|


**Logic/steps:**

1. Find the attempt and check that it has not yet been consumed. If the attempt is not found or has already been consumed, the response is the same as for an invalid code.
2. Reject an expired challenge without incrementing the input counter.
3. Compare secret. The code and token are stored in the database in a form from which they cannot be restored. If the code does not match, the attempt counter increases.
4. If successful, transfer the user to the active state, assign the role `user`, if the RBAC module is connected and the role has not yet been assigned, and consume the challenge.

**Answers:**

- **Success confirm:** **200 OK**, `id`, `email`, `status: active`.
- **Success resend:** **202 Accepted**, `confirmationRequired: true`, `method`, `attemptId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`. There is no secret in the answer.
- **Errors:** see section 1.4.



### 1.4 Errors and limitations

- **400** - incorrect email.
- **400** - the password does not pass the policy.
- **409** - email has already been registered.
- **400** - invalid or expired confirmation code or token, as well as an attempt not found and already consumed.
- **429** - Exhausted code entry attempts, resending before 60 seconds, or registering too frequently.
- **503** - the email was not sent. The entry `pending` and the challenge are saved.

Instead of `409`, a generic response is allowed, which cannot be used to determine whether the email is already in use. In this case, the same response should be returned by resending. The neutral response does not contain `id` of an existing account and does not repeat the body of successful creation, if this body shows whether the account has been created. The default is explicit `409`.

### 1.5 Audit/logs

Log: registration attempts (success and failure), sending code or link, successful and unsuccessful confirmations.

The log does not include the password, password hash, code, link token, or entire request body.

### 1.6 Non-functional requirements

- Protection against spam and brute force: rate limit for registration and resending. The numerical registration threshold is set in the configuration.
- The password and secret of the email cannot be recovered from the database, API response or log.
- General non-functional project requirements (input data validation, API description, tests) also apply to these operations.


---

# 1.1 RBAC — Practical task

_Source: [1.1 RBAC.md](<1.1 RBAC.md#practical-task>)_

Role-based access control functionality in the system.
An authenticated user has access to a protected operation only if at least one of their roles allows the required action. The administrator manages roles, permissions, assignments, and user roles through the API. Changes are applied without restarting, and the absence of a rule always means access is denied.

## 1) RBAC

### 1.1 General

**Purpose:** to centrally check and change user permissions through roles and permissions.

**Users/roles:**

- authenticated user - subject of access verification;
- RBAC administrator - user with permission `rbac@manage`;
- one user can have zero, one or more roles.

**Dependencies/related settings:**

- the authentication module checks the access JWT from the cookie and passes `userId`;
- the database stores users, roles, permissions, actions and assignments;
- the server stores a snapshot of the policy and its version for updating without restarting;
- `RBAC_BOOTSTRAP_ADMIN_USER_ID` specifies an existing user to whom bootstrap assigns the role `admin`.

The bootstrap is performed once and only for an empty RBAC configuration. It creates permission `rbac` with action `manage` and permission `users` with actions `read`, `read_any`, `update`, `update_any`, `delete`, `delete_any`, `list`. The `user` role is assigned to `users@read`, `users@update` and `users@delete`. Role `admin` receives `rbac@manage` and all actions `users`. The user from `RBAC_BOOTSTRAP_ADMIN_USER_ID` receives `admin`. Each existing user without roles receives `user`. Restarting does not reassign roles. Bootstrap has no public endpoint.

The role `user` is then assigned in the same transaction in which registration transfers the user to `active` if this relationship does not already exist. User `pending` does not receive the role. The composition of permissions is chosen by RBAC, not by the registration request. After at least one administrator appears, further assignments are changed via the API. An operation after which no user would save `rbac@manage` is prohibited.

The session and JWT are created by the authentication module. RBAC does not issue tokens and does not check passwords.

Each protected operation specifies `permission` and `action` in the server handler configuration. The client does not select these values.

### 1.2 User stories

1. **Allowed operation:** The user has multiple roles, and at least one of them contains the required permission and action; the handler is executed.
2. **Illegal operation:** user is authenticated, but there is no matching destination; the server returns **403** without calling the handler.
3. **Loading at startup:** the application loads roles, actions and assignments from the database and becomes ready to accept protected requests.
4. **Dynamic Update:** The administrator changes the policy, the version is incremented, and the following queries use the new state without restarting or re-logging in.
5. **Policy Management:** The administrator creates, views, replaces, and deletes roles, permissions, and assignments.
6. **Assigning roles to a user:** administrator replaces the list of user roles; an empty list removes all roles and leaves protected operations prohibited.
7. **Default role:** transition to `active` assigns the role to `user` if it is not already assigned. Your profile, its changes and confirmed deletion become available without a separate assignment.

### 1.3 Contract

#### 1.3.1 Access check

| `authorize(userId, permission, action)` |Checks/validation|
| --- | --- |
| `userId: string` |It is taken only from the context after checking the access JWT. The value from the body, query or arbitrary header is not accepted|
| `permission: string` |Set by a protected handler, normalized to lower case, and exists in the policy|
| `action: string` |Set by a protected handler, normalized to lowercase and valid for permission|

**Logic/steps:**

1. Authenticate the request. If there is no valid session, return **401** without calling RBAC.
2. Check the version of the local snapshot with the version of the policy in the database.
3. If the versions are different, load the new snapshot completely, check the connections and atomically replace the current one.
4. Find all user roles by `userId`.
5. For each role, find an assignment with the required permission.
6. Allow access if at least one assignment covers all actions or contains the required action.
7. If there is no match, return **403**. The handler and reading of the target resource fails.

Roles from JWT do not participate in the solution. Changing assignments is effective for the next request without issuing a new token.

**Answers:**

- **Access allowed:** internal result `allowed`; the protected handler is executed.
- **Access denied:** **403 Forbidden** with a standard error without a list of roles, permissions and information about the existence of the target resource.
- **Current policy unavailable:** **503 Service Unavailable**; the handler is not executed and the old snapshot is not used.

RBAC responses do not contain JWTs, cookies, passwords, password hashes, or internal snapshot contents.

#### 1.3.2 Role management

|Operation|Inputs and rules|
| --- | --- |
| `GET /admin/rbac/roles` |Return list of roles|
| `POST /admin/rbac/roles` |`name: string`, `description?: string`; create a role|
| `PUT /admin/rbac/roles/{roleId}` |`name: string`, `description?: string`; completely replace mutable fields|
| `DELETE /admin/rbac/roles/{roleId}` |Delete a role only without permission assignments and without assigned users|

`name` is trimmed at the edges and converted to lowercase. Acceptable characters are from 1 to 64 using the `^[a-z][a-z0-9._-]{0,63}$` pattern. The uniqueness of the normalized name is ensured by the database constraint. `description` after trimming contains no more than 500 characters; the empty string is saved as `null`.

The ID is generated by the server. The role view contains `id`, `name`, `description`, `createdAt`, `updatedAt`.

**Logic/steps:**

1. Check session and `rbac@manage`.
2. Validate the path and body of the request.
3. Change and increase the policy version in a single transaction.
4. Convert the unique constraint conflict to **409** rather than an unhandled error.

**Answers:**

- **List:** **200 OK**, array of roles.
- **Creation:** **201 Created**, created role.
- **Replacement:** **200 OK**, current role.
- **Deletion:** **204 No Content**, no body.
- **Errors:** see section 1.4.

Responses contain only role fields and do not contain user data, JWTs, cookies or other secrets.

#### 1.3.3 Permission management

|Operation|Inputs and rules|
| --- | --- |
| `GET /admin/rbac/permissions` |Return permissions along with valid actions|
| `POST /admin/rbac/permissions` |`name: string`, `description?: string`, `actions: string[]`; create permission|
| `PUT /admin/rbac/permissions/{permissionId}` |`name: string`, `description?: string`, `actions: string[]`; completely replace the editable fields and set of actions|
| `DELETE /admin/rbac/permissions/{permissionId}` |Remove permission only if there are no role assignments|

`name` and each action are normalized and checked according to the same rules as the role name. `actions` contains 1 to 64 unique values after normalization. Repeating one action in an array is considered an error **400**.

Removing an activity that is part of a specific role assignment returns **409**. To assign all actions, deletion is acceptable: after a change, it only covers the remaining actions. A later added action is automatically included in assignments with the all actions flag and is not included in assignments with an explicit list.

The ID is generated by the server. The permission view contains `id`, `name`, `description`, normalized `actions`, `createdAt`, `updatedAt`.

**Logic/steps:**

1. Check session and `rbac@manage`.
2. Validate the permission and the entire set of actions.
3. Check existing assignment links.
4. Ensure that the resulting policy leaves at least one user with `rbac@manage`.
5. Record permission, actions, and new policy version in one transaction.

**Answers:**

- **List:** **200 OK**, an array of permissions with actions.
- **Created:** **201 Created**, created permission.
- **Replacement:** **200 OK**, current permission.
- **Deletion:** **204 No Content**, no body.
- **Errors:** see section 1.4.

The responses do not contain users, tokens, cookies or application secrets.

#### 1.3.4 Managing permission assignments

|Operation|Inputs and rules|
| --- | --- |
| `GET /admin/rbac/grants` |Revert role assignments|
| `POST /admin/rbac/grants` |`roleId: string`, `permissionId: string`, `actions?: string[]`; create appointment|
| `PUT /admin/rbac/grants/{grantId}` |`roleId: string`, `permissionId: string`, `actions?: string[]`; completely replace the purpose|
| `DELETE /admin/rbac/grants/{grantId}` |Delete assignment|

The role and permission must exist. One assignment is allowed for one pair `roleId` + `permissionId`. A missing or empty `actions` means all current and future actions of this permission. The non-empty array contains only the unique actions from `permission_actions`.

The API explicitly returns `allActions: true` and `actions: []` to assign all actions. For limited purpose, `allActions: false` and the normalized non-empty `actions` are returned.

The ID is generated by the server. The destination view contains `id`, `roleId`, `permissionId`, `allActions`, `actions`, `createdAt`, `updatedAt`.

**Logic/steps:**

1. Check session and `rbac@manage`.
2. Verify that the role, permission, and listed actions exist.
3. Check the uniqueness of the role and permission pair.
4. Record the purpose, selected actions, and new version of the policy in one transaction.
5. Before committing, make sure that at least one user with `rbac@manage` remains in the final policy.

**Answers:**

- **List:** **200 OK**, array of assignments.
- **Creation:** **201 Created**, created assignment.
- **Replacement:** **200 OK**, current purpose.
- **Deletion:** **204 No Content**, no body.
- **Errors:** see section 1.4.

Responses do not contain JWT, cookies, or user data other than identifiers directly related to the operation.

#### 1.3.5 Assigning roles to a user

|Operation|Inputs and rules|
| --- | --- |
| `GET /admin/rbac/users/{userId}/roles` |Return role IDs of an existing user|
| `PUT /admin/rbac/users/{userId}/roles` |`roleIds: string[]`; completely replace the list of user roles|

All `roleIds` must exist and not be repeated. An empty array is acceptable and removes all roles. Removing an unused role is performed as a separate operation from section 1.3.2.

**Logic/steps:**

1. Check session and `rbac@manage`.
2. Check the existence of the user and all roles.
3. Replace relationships `user_roles` and increase the policy version in one transaction.
4. Reject a change if no user saves `rbac@manage` after it.

**Answers:**

- **Reading:** **200 OK**, `userId` and `roleIds`.
- **Replacement:** **200 OK**, `userId` and the current value `roleIds`.
- **Errors:** see section 1.4.

The response does not contain email, password, hash, JWT, cookies or user profile fields.

#### 1.3.6 Policy coherence

**General rule:** The configuration in the database is the source of truth, and the snapshot is read-only.

**Logic/steps:**

1. At startup, load the policy and its `version`. The readiness check does not pass until the load is successful.
2. Perform each administrative change together with `version + 1` in one transaction.
3. Before each access check, compare the snapshot version with the database version.
4. If there is a discrepancy, build a new snapshot separately and replace the old one only after a complete successful load.
5. If the change transaction is rolled back, leave the same data and version.
6. If the change is committed, but the new snapshot is temporarily not loaded, save the change in the database and return to protected operations **503** until a successful reload. There is no need to repeat the administrative request.

A query running at the same time as a change commit may complete under the old or new version. Each request initiated after a successful administrative operation response uses the new version.

Direct modification of RBAC tables that bypasses the service is not supported unless it increments `rbac_policy_state.version` in the same transaction.

### 1.4 Errors and limitations

- **400 Bad Request** - invalid identifier, name, description or body; empty permission action set; repeat value in array; The action does not belong to the permission.
- **401 Unauthorized** - access JWT is missing, invalid or expired. This response forms the pre-RBAC authentication module.
- **403 Forbidden** - The user is authenticated but does not have the required permission and action.
- **404 Not Found** - The role, permission, assignment, or user from the administrative operation was not found.
- **409 Conflict** - the role or permission name is already taken; the role and permission pair are already assigned; the entity being deleted is used; The action to be deleted is part of a specific assignment; the change would leave the system without a user with `rbac@manage`.
- **503 Service Unavailable** - the database or current snapshot of the policy is unavailable. The protected handler is not executed.

In a protected business transaction, the entitlement check is performed before the search for the target resource. An unentitled user gets **403** rather than **404**, even if the resource ID does not exist. In administrative operations, **404** is returned only after successful verification of `rbac@manage`.

### 1.5 Audit/logs

Log:

- creating, replacing, and deleting roles, permissions, and assignments;
- replacing user roles;
- rejected administrative operations with the result **400**, **403**, **404**, **409** or **503**;
- failures of normal access checks with `actorUserId`, `permission`, `action` and operation ID;
- policy version change, snapshot reload success, and reload errors.

For an administrative event, `actorUserId`, the operation type, the entity type and ID, the policy version, and the result are stored. The values `description`, the full request body and the full snapshot are not logged.

The log does not include JWT, cookies, password, password hash, application secrets and entire request headers.

### 1.6 Non-functional requirements

- Access checks are applied centrally; public transactions are marked explicitly. An error or incomplete configuration results in either **503** being denied, but not allowing access.
- Changes to related tables and policy versions are atomic. Indexes cover user roles, assignments, and unique names.
- Automated tests cover enable and disable, role merging, all and individual actions, transaction rollback, snapshot unavailability, and role assignment `user` when transitioning to `active`.
- The general non-functional requirements of the project - CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.2 Authentication — Practical task

_Source: [1.2 Authentication.md](<1.2 Authentication.md#practical-task>)_

User authentication functionality in the system.
The guest logs in using email and password, after which he immediately receives access and refresh in HttpOnly cookies or first confirms login vian email. Access is valid for 15 minutes, refresh - 30 days. Refresh sessions are not stored on the server, logout clears cookies, and each token is accepted only for an existing user in the `active` state.

## 1) Authentication

### 1.1 General

**Purpose:** to establish the user's identity by email and password, issue a JWT pair and support refresh and logout.

**Users/roles:**

- guest - performs login and email challenge;
- user with refresh-cookie - refreshes a pair of tokens;
- any client can call idempotent logout.

**Dependencies/related settings:**

- registration creates a user and a slow password hash, but does not issue tokens;
- `LOGIN_EMAIL_CONFIRMATION_ENABLED` enables the second step for login only;
- `LOGIN_EMAIL_CONFIRMATION_METHOD` has one value, `otp` or `magic_link`, which is selected by the server;
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` contain different random values of at least 32 bytes in length;
- `LOGIN_CHALLENGE_HMAC_KEY` contains a separate random key of at least 32 bytes in length;
- `JWT_ISSUER` and `JWT_AUDIENCE` are required and are used equally for release and verification;
- SMTP and the trusted frontend address are set in the application configuration;
- Default cookie policy: host-only, `HttpOnly`, `Secure`, `SameSite=Strict`, without `Domain`.

While there is no separate API settings, the flag and method of login confirmation change in the application configuration. The change only applies to new login requests; an attempt already created retains its method and can be confirmed or resubmitted.

If any required key is missing, empty, or shorter than 32 bytes, the application exits at startup and fails the readiness check. Test value, random key for each launch and general key for access, refresh and email challenge are prohibited.

RBAC does not trust the roles from the JWT and obtains the actual assignments from the server data. Authentication passes it only verified `userId`.

### 1.2 User stories

1. **Login without confirmation:** A user with the correct email and password in the `active` state receives two cookies.
2. **Login with OTP:** After the correct password, the user receives `attemptId`, enters a six-digit code and only then receives cookies.
3. **Login with magic link:** After the correct password, the user receives an email, opens the page and confirms the login with a separate POST with a token.
4. **Resend:** the user waits 60 seconds, after which he receives a new code or link; the old secret stops working.
5. **Token update:** valid refresh and current status `active` give a new pair without entering a password.
6. **Output:** the server clears both cookies, even if they are missing or no longer valid.
7. **Termination of access:** `pending`, `blocked`, `deleting`, `deleted` and an absent user do not pass login, access or refresh.

### 1.3 Contract

#### 1.3.1 Login request

| `POST /auth/login` |Checks/validation|
| --- | --- |
| `email: string` |Required, valid format; outer spaces are removed and emails are converted to lowercase|
| `password: string` |Required; Outer and inner spaces are preserved, the value is not normalized|

**Logic/steps:**

1. Check body format and rate limit before expensive hash check.
2. Receive a user by normalized email. If the entry is missing, check the password using a previously prepared fictitious hash.
3. Compare the password with the `password_hash` library function.
4. For missing user, invalid password, and any status other than `active`, return the same generic error **401**.
5. If login confirmation is disabled, sign access and refresh, then set both cookies with one response.
6. If confirmation is enabled, check the user's previous incomplete challenge. Until 60 seconds have passed since its `last_sent_at`, return **429** with the remaining time without creating a challenge or sending an email.
7. After the delay, use one transaction to lock the user and then the previous challenge, recheck `active` and the 60-second delay, consume the previous challenge, and create a new one using the method selected by the server. If the status changes, return the generic **401** response without an email. Commit the challenge before accessing SMTP.
8. Convey the secret only in an email. At this step, JWTs and cookies are not issued.

If the challenge transaction is not committed, the email is not sent, the client receives **503** and can retry login. If SMTP does not accept the email after the transaction commits, the challenge is retained, and the **503** response contains `confirmationRequired`, `method`, `attemptId`, and `retryAfterSeconds`, but no secret. Retry using resend or a new login after the same 60-second delay; both paths replace the secret and enforce the sending limit.

Both JWTs are created before the response is generated. If signing at least one token fails, no `Set-Cookie` headers are sent and **503** is returned. A successful response lost by the client does not create a server session: direct login can be repeated, and an already consumed email challenge starts again with login.

**Answers:**

- **Direct success:** **204 No Content**, `Set-Cookie` for access and refresh, no body.
- **Need second step:** **202 Accepted**, `confirmationRequired: true`, `method`, `attemptId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`.
- **Invalid details or status:** **401 Unauthorized** with one code `invalid_credentials`.
- JSON does not contain password, hash, JWT, OTP, link token, keys, roles or account existence information.

#### 1.3.2 Confirmation and resend

|Operation|Inputs and rules|
| --- | --- |
|`POST /auth/login/confirm` for OTP|`attemptId: string`, `code: string`; the code contains exactly 6 digits|
|`POST /auth/login/confirm` for magic link|`token: string` in `attemptId.secret` format; random `secret` contains 32 bytes before base64url encoding, the email transmits the token in the URL fragment|
| `POST /auth/login/resend` |`attemptId: string`; the method of trying does not change|

**Acknowledgment logic:**

1. By challenge ID, get `user_id` without making a decision, then block the user and the challenge row in that order and re-read their status. An challenge not found receives **400**.
2. If `attempts` is already equal to 5 and `consumed_reason` is equal to `attempts_exhausted`, return **429**. An challenge not found, expired, successfully consumed, replaced or consumed as `user_inactive` receives a general response of **400**.
3. Delay is defined as `last_sent_at + 10 minutes`; an overdue challenge does not increase `attempts`.
4. Check an already blocked user using `user_id`. If it is missing or its status is not `active`, consume the challenge with reason `user_inactive` and return the same **401 invalid_credentials** that was used at entry.
5. Calculate HMAC-SHA256 of the sent secret and compare with `secret_hash` in constant time.
6. If the OTP is incorrect, increase `attempts` in the same transaction. The fifth input is still being checked; the fifth incorrect input returns **400** and cancels the attempt with reason `attempts_exhausted`. The following input returns **429**.
7. If the magic link is incorrect, return **400**; the counter is not applied to the link.
8. If there is a match, sign both JWTs, consume the challenge with reason `confirmed`, commit the transaction and set two cookies.

If token signing or transaction commit fails, no cookies are sent, **503** is returned, and the failed attempt can be reconfirmed. If the response is lost after committing, the attempt remains consumed and the user begins a new login.

**Logic resend:**

1. By `attemptId`, get `user_id`, block the user, then try and accept only the active user's challenge. An expired TTL disables confirmation but not resend; a challenge not found, replaced, confirmed or consumed as `user_inactive` receives **400**, and `attempts_exhausted` receives **429**.
2. If less than 60 seconds have passed since `last_sent_at`, return **429** and the number of seconds remaining.
3. Create a new secret using the same method, replace `secret_hash`, set a new `last_sent_at` and reset `attempts` in one transaction.
4. After fixing, send an email. The old code or link no longer works.
5. If SMTP did not accept the new email, return **503**. The new hash remains saved, the old secret is not restored, the next sending is possible in 60 seconds.

**Answers:**

- **Confirmation:** **204 No Content** and two cookies, no body.
- **Resend:** **202 Accepted**, `method`, `attemptId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`.
- **Errors:** see section 1.4.
- The responses do not contain JWT, password, hash, OTP, link token and HMAC.

#### 1.3.3 JWT and cookies

| Claim | Access | Refresh |
| --- | --- | --- |
| `sub` |user ID|same user id|
| `iss` |value `JWT_ISSUER`|value `JWT_ISSUER`|
| `aud` |value `JWT_AUDIENCE`|value `JWT_AUDIENCE`|
| `iat` |server release time|server release time|
| `exp` | `iat + 15 minutes` | `iat + 30 days` |
| `token_use` | `access` | `refresh` |

The signature algorithm is HS256 only. Access is signed `JWT_ACCESS_SECRET`, refresh - `JWT_REFRESH_SECRET`. `jti`, roles, email, password, hash and personal data are missing in the payload. The full JWT is not stored anywhere on the server.

| Cookie |Default attributes|
| --- | --- |
| `access_token` |`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`, without `Domain`|
| `refresh_token` |`HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=2592000`, without `Domain`|

The cookie expiration date is the same as `exp`. The server does not return tokens in the JavaScript-accessible body, header, or URL. All operations work only over HTTPS; There is no exception for an unprotected production environment.

By default, frontend and API have the same origin. For another trusted origin, CORS lists the exact origin, resolves credentials and the `X-CSRF-Protection` header, and the browser sends requests with `credentials: "include"`. All POST requests from another origin check the exact `Origin` and the `X-CSRF-Protection: 1` header, regardless of whether both origins are from the same site. If origin is on another site, both auth cookies additionally receive `SameSite=None; Secure`. A rejected CSRF check returns **403** with code `csrf_rejected`.

#### 1.3.4 Updating tokens

| `POST /auth/refresh` |Checks/validation|
| --- | --- |
| Cookie `refresh_token` |Mandatory; JWT must have HS256, valid signature, `iss`, `aud`, `iat`, `exp`, non-empty `sub` and `token_use=refresh`|

**Logic/steps:**

1. Extract refresh from cookies only; do not accept the value from the body, query or other header.
2. Check the format, algorithm, signature and claims with a permissible clock discrepancy of no more than 30 seconds.
3. Get user by `sub` from the database.
4. If the user is absent or has the status `pending`, `blocked`, `deleting` or `deleted`, return **401** without issuing cookies.
5. For user `active`, sign a new access for 15 minutes and a new refresh for 30 days from the current moment.
6. Set both cookies with one response. Do not save the previous refresh and do not add it to the denylist.

Rotation does not invalidate the used refresh: any copy of it remains cryptographically valid up to its own `exp`. Reuse is not detected, and a specific refresh is not forced to be withdrawn.

If the database is unavailable, return **503**, not **401**. If signing the new pair fails, return **503** without `Set-Cookie`; The client's previous cookie remains retryable until its `exp`.

**Answers:**

- **Success:** **204 No Content** and a new pair of cookies.
- **Invalid session:** **401 Unauthorized** with code `invalid_session`.
- The response does not contain JWT, `sub`, user status, roles or keys.

#### 1.3.5 Exit

| `POST /auth/logout` |Rule|
| --- | --- |
|Body missing|The operation does not require a valid access or refresh and always clears the cookies of the current client|

The server sends expired `access_token` and `refresh_token` with the same `Path`, `Secure`, `SameSite` and missing `Domain` that were used during installation. For cross-origin configuration, CSRF check is used, and for cross-site configuration, `SameSite=None` is additionally stored.

**Answer:** **204 No Content** regardless of the presence of cookies. There is no body, JWT or user information.

Logout does not write the refresh to the database and does not recall its copy on another device. After clearing, the client removes the local interface state and proceeds to the login form.

#### 1.3.6 Access check

**General rule:** Every protected operation first triggers a single authentication check.

|Login|Checks/validation|
| --- | --- |
| Cookie `access_token` |HS256, signature, `iss`, `aud`, `iat`, `exp`, non-empty `sub`, `token_use=access`|

**Logic/steps:**

1. Check access with an acceptable clock discrepancy of no more than 30 seconds.
2. Get user by `sub`, selecting only `id` and `status`.
3. Accept only existing user with status `active`.
4. Pass on `userId`, but not claims roles.

Missing cookie, invalid or expired JWT, unknown user and statuses `pending`, `blocked`, `deleting`, `deleted` give one response **401 invalid_session**. The unavailability of the database gives **503**. If successful, there is no separate HTTP response: the request goes to RBAC and a handler.

### 1.4 Errors and limitations

- **400 Bad Request** - incorrect login, confirm or resend format; incorrect or expired OTP or magic link; attempt not found, replaced, already successfully used or consumed as `user_inactive`.
- **401 Unauthorized** - generic rejection for unknown email, incorrect password and a user whose status is not `active`; access or refresh is missing, invalid, has expired, is of the wrong type, or refers to an absent or inactive user.
- **403 Forbidden** - a request from an untrusted origin or the required CSRF check failed; The response code `csrf_rejected` does not override the RBAC solution.
- **429 Too Many Requests** - entry rate limit exceeded; a new email via login or resend was requested before 60 seconds; OTP has already exhausted five inputs.
- **503 Service Unavailable** - the database, SMTP or signature operation are unavailable; the partial failure condition is described in the corresponding operation.

Login error **401** has the same code `invalid_credentials`, text and form for unknown email, incorrect password, `pending`, `blocked`, `deleting` and `deleted`. The session error has the general code `invalid_session` and does not indicate which JWT or user validation failed.

### 1.5 Audit/logs

Log:

- successful and unsuccessful login, triggering of both rate limits and the result of the email challenge;
- creation, resend, successful confirmation, invalid input, delay and exhaustion of attempt;
- successful and unsuccessful refresh, logout and access check failure;
- unavailability of the database, SMTP and token signing;
- origin or CSRF check rejected.

For a known user, `userId`, event type, challenge method, `attemptId`, result, time and request ID are stored. For unknown email, an irreversible service ID with a separate key is used to match attacks without recording the address. The JWT failure reason is logged by category `missing`, `malformed`, `signature`, `expired`, `claims`, `token_use`, or `user_inactive`, but a general error is returned to the outside.

The log does not include cleartext email, password, password hash, OTP, magic link token, HMAC, JWT, `Cookie`, `Set-Cookie`, keys, full URL, full request body and full headers.

### 1.6 Non-functional requirements

- `POST /auth/login` allows no more than 30 requests from IP per minute and no more than 5 unsuccessful checks per email and IP pair in 15 minutes. Refresh - no more than 30 requests from IP per minute. OTP has 5 attempts, resend - a pause of 60 seconds.
- The indexes cover the search for normalized email and the single outstanding challenge for `user_id`. Confirmation is performed transactionally.
- Automated tests cover direct login, both email methods, fifth challenge, resend, logout, user statuses and CSRF.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.3 Authorization — Practical task

_Source: [1.3 Authorization.md](<1.3 Authorization.md#practical-task>)_

Functionality for authorizing user requests in the system.
Each protected operation first checks the access JWT and the current user status, then applies RBAC and only then runs the handler. Missing session returns **401**, insufficient privilege for the identified user returns **403**, and data unavailable for safe decision returns **503**.

## 1) Authorization

### 1.1 General

**Purpose:** to centrally allow only active users with current permission to secure operations.

**Users/roles:**

- guest - calls only explicitly public operations;
- authenticated user - passes access check and RBAC;
- RBAC administrator - goes through the same chain with permission `rbac@manage`.

**Dependencies/related settings:**

- authentication issues an access JWT for 15 minutes in the HttpOnly cookie `access_token`;
- access is checked according to the authentication contract: HS256, access key, `iss`, `aud`, `iat`, `exp`, `sub`, `token_use=access`;
- the user database is the source of the current `status`;
- RBAC provides an up-to-date snapshot of roles, permissions, actions, assignments and `version`;
- each HTTP operation has a public label, one `permission@action` pair, a declared receipt, or a receipt together with one pair;
- cookie and CORS policies coincide with authentication: same-origin, host-only, `Secure`, `SameSite=Strict` by default.

Issue and refresh JWT, email challenge and logout are performed by authentication. Authorization does not sign tokens, set cookies, check passwords, and does not store refresh, `jti`, or server session.

Roles and permissions from JWT, body, query and custom headers are ignored. RBAC uses only up-to-date server data according to the role management contract.

### 1.2 User stories

1. **Allowed request:** access is valid, user `active`, and one of the current roles contains the required action; the handler is executed.
2. **No session:** access is missing, damaged, expired or has invalid claims; the server returns **401** without calling RBAC.
3. **User is no longer active:** JWT is valid but the user is missing, `pending`, `blocked`, `deleting` or `deleted`; the server returns **401**.
4. **No right:** Identity has been established, but there is no matching appointment; the server returns **403** without reading the target resource.
5. **Policy unavailable:** The current snapshot cannot be obtained; the server returns **503** and does not use the old permissions.
6. **Access has expired:** the client performs one refresh, and after success repeats the request once.
7. **Public operation:** explicit public label skips access and RBAC; the occasional invalid cookie does not change its contract.
8. **Owner check:** After the general RBAC handler loads the resource and allows the action only to its owner.

### 1.3 Contract

#### 1.3.1 Protected operation

|Login|Source and rule|
| --- | --- |
| Cookie `access_token` |Single source access JWT; the value from `Authorization`, body, query and other header is not accepted|
| `permission` |Normalized permission name from handler server configuration|
| `action` |Normalized action of the same handler|
|HTTP method and path|Used to select transaction metadata, but do not determine the right from the client data|

**Logic/steps:**

1. Find the server declaration of the operation. If it is clearly public, go to the access and RBAC handler indiscriminately.
2. For a secure operation, extract `access_token` from the cookie and check HS256, signature, `iss`, `aud`, `iat`, `exp`, non-empty `sub` and `token_use=access`.
3. For any access error, return **401 invalid_session**. RBAC, resource reading and handler do not call.
4. Get from `users` only `id` and `status` by `sub`. Accept only existing user with status `active`; return other cases as **401 invalid_session**.
5. For a state-changing operation from another origin, check for a valid `Origin` and a required CSRF header regardless of the site boundary. After the identity has been established, **403 csrf_rejected** receives a refusal.
6. Pass only `userId`, `permission` and `action` from the handler to RBAC.
7. Check the snapshot version against the policy version. If there is a mismatch, completely load and atomically install a new snapshot.
8. If the current snapshot is not available, return **503 authorization_unavailable** without using the old one.
9. If no current role allows the action, return **403 permission_denied**.
10. Only after allowing RBAC to read the target resource, perform ownership checks and run business logic.

Access is checked at the start of the request. Expiration of `exp` during an already admitted handler does not interrupt it. A user ban or policy change recorded after appropriate verification is effective for the following requests; A long-running critical operation repeats the check before committing under its own contract if necessary.

If the user database is unavailable, return **503** rather than **401**. If user verification passes but RBAC is not available, also return **503**. In both cases, the handler does not run and there are no partial business changes.

**Answers:**

- **Access allowed:** status and body are determined by the business handler.
- **Identity not established:** **401 Unauthorized**, code `invalid_session`.
- **Request prohibited:** **403 Forbidden**, code `permission_denied`, `ownership_denied` or `csrf_rejected`.
- **Solution unavailable:** **503 Service Unavailable**, code `authorization_unavailable`.
- The authorization response does not contain JWT, cookies, `sub`, user status, user roles, required permission, internal version and snapshot content.

#### 1.3.2 Declaration of transactions

|Type of operation|Mandatory server declaration|
| --- | --- |
|Public|`public=true`; access and RBAC do not start|
|Protected|exactly one pair `permission@action`; `public` missing|
|By receipt|header name; if it is present, access and RBAC do not start. One pair of `permission@action` is allowed nearby for a call without a header|

Registration, login, email confirm/resend, refresh, logout and minimal liveness check operations are marked as public. Each of them applies its own checks, rate limits and statuses. Readiness can only be accessed by internal infrastructure. The deletion status is not public: the header `Deletion-Receipt` opens the owner's branch, and the pair `users@delete` is valid without it.

All other operations are protected by default. At startup, the application checks the declaration, and the request names go through the RBAC format. `public=true` together with a pair or a receipt, as well as the absence of any declaration, remove readiness; if the request does reach the process, it receives **503 authorization_unavailable** and the handler is not executed. Receipt along with one pair is acceptable. If the declared header is present, the receipt is checked. If it is not there, a pair is needed, and the request follows the usual chain.

Unknown in the current policy `permission` or `action` is not a client error and gives **403 permission_denied**. Adding a destination to RBAC begins to allow the following requests without changing the handler and without a new JWT.

The client does not transmit the transaction type, `permission` or `action`. OpenAPI only marks protected operations with a cookie security, but the documentation is not the source of the solution: server-side metadata is checked independently.

#### 1.3.3 Refresh and repeating the request on the client

**General rule:** refresh is triggered only after **401 invalid_session** from a protected operation.

**Logic/steps:**

1. On the first **401 invalid_session**, suspend other requests that receive the same error.
2. If refresh is already running, join its result; do not send the second `POST /auth/refresh`.
3. With **204** from refresh, repeat each suspended request once with new cookies.
4. If the replay returned **401** again, no longer refresh tokens, clear the user's local state, and show the login.
5. With **401** from refresh, perform the same cleaning and go to the input.
6. With **503**, refresh does not clear the user state and does not create a loop; show temporary error and allow manual retry later.
7. The response **403** or **503** of the original protected operation does not trigger refresh.

The repetition is acceptable because **401** guard was formed before the handler and the original business operation did not start. A lost network response without a confirmed **401** is not automatically repeated. A streaming or otherwise non-replayable body requires a new user action.

The client does not read the JWT and does not evaluate `exp`: HttpOnly-cookie is not accessible by JavaScript, and the solution source is the server response. With a different origin, the original request, refresh and retry use `credentials: "include"`.

#### 1.3.4 Resource and ownership

**General rule:** general check `permission@action` precedes the search for the target resource.

**Logic/steps:**

1. After RBAC, get a resource by identifier.
2. If the resource is missing, return **404 Not Found**.
3. If the operation has an additional owner, organization, or status rule, check it against the authenticated `userId` and resource data.
4. If there is a discrepancy, return **403 ownership_denied**.
5. Read or change only after both checks.

A user without general permission receives **403 permission_denied** regardless of the existence of the ID. A user with general permission can get **404** because they are already allowed to search for that resource type.

The transaction and the state after partial failure belong to the business operation. Authorization ensures that the handler did not start before admission, but does not replace the change transaction itself.

#### 1.3.5 Cookies, CORS and CSRF

By default, frontend and API have the same origin. `access_token` remains host-only cookie with `HttpOnly; Secure; SameSite=Strict; Path=/`; authorization does not reinstall it.

For another trusted origin, the server returns the specific `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true` and resolves the necessary methods and headers. Wildcard `*` is prohibited for credentialed requests. The client is using `credentials: "include"`.

A protected state-changing operation from another origin, after a successful access check, only accepts the exact allowed `Origin` and `X-CSRF-Protection: 1`. This rule also applies to same-site origin. If the frontend is located on another site, authentication additionally sets cookies with `SameSite=None; Secure`. GET and HEAD do not change state.

CORS preflight does not require an access cookie and responds only to the allowed origin, method, and header set. A successful preflight does not mean the business transaction is resolved; the actual request still goes through access, user and RBAC.

#### 1.3.6 Partial failures

- If access is correct, but reading the user failed, **503** is returned; RBAC and handler do not start.
- If the user has been identified but the RBAC version or snapshot is not available, **503** is returned; the old snapshot is not used.
- If the audit is not temporarily sent to the external system, the access decision is not changed and the handler is not repeated. The error is written to a local structured log and affects the readiness monitoring of the log channel.
- If a business handler starts and fails, its status is saved. Authorization does not convert the business failure to **401** or **403** and does not retry the operation.
- If the required JWT keys are missing or the initial RBAC snapshot is not loaded, the application fails readiness and does not accept protected requests.

### 1.4 Errors and limitations

- **400 Bad Request** - business login was not validated after successful authorization; this is not the result of access or RBAC.
- **401 Unauthorized** - `access_token` is missing, damaged, expired, signed with the wrong key, has the wrong claims or type; user by `sub` is missing or not `active`.
- **403 Forbidden** - the active user does not have the required permission, does not pass ownership, or has not fulfilled the CSRF condition of the state-changing operation.
- **404 Not Found** - resource not found after successful RBAC.
- **429 Too Many Requests** - the rate limit of a protected business transaction was triggered; refresh does not run automatically.
- **503 Service Unavailable** - the user database, current RBAC snapshot or correct route configuration are not available.

**401** never means a missing role, and **403** is never used for a missing, expired, or invalid session. Dependency unavailability is not reported as a permissions change and always receives **503**.

The common law check is performed before the resource is read. Therefore, without the right, the answer is always **403**, and **404** is possible only after access to the resource search.

### 1.5 Audit/logs

Log:

- **401** with category `missing`, `malformed`, `signature`, `expired`, `claims`, `token_use` or `user_inactive`;
- **403** with category `permission_denied`, `ownership_denied` or `csrf_rejected`;
- **503** with dependency category `users`, `rbac_version`, `rbac_snapshot` or `route_configuration`;
- successful admission to critical operations;
- an operation detected at startup without a correct declaration;
- single-flight refresh and its result on the client side without cookie content.

For an RBAC solution, the log contains `requestId`, `actorUserId`, the operation name, the server `permission` and `action`, the policy version, and the result. The target resource ID is added only after it is allowed to be read. The full list of roles and permissions is not recorded.

The log does not include JWT, `Cookie`, `Set-Cookie`, keys, password, hash, email challenge, full request body, full headers and sensitive resource data.

### 1.6 Non-functional requirements

- A single chain of access → current user → CSRF for change → RBAC → resource → handler applies to all protected operations. Public routes are clearly marked.
- An error or incomplete configuration results in **401**, **403**, or **503**, but never resolves the request.
- Automated tests cover the check order, all reasons **401**, failure **403**, unavailability of **503**, user blocking, role change without new JWT and ownership.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.4 Viewing User Data — Practical task

_Source: [1.4 Viewing User Data.md](<1.4 Viewing User Data.md#practical-task>)_

Functionality for viewing user data in the system.
An active user with `users@read` receives his own safe profile. For someone else's profile, `users@read_any` is additionally required; both checks are performed before searching for the target record. The response is always limited to seven canonical fields, and the photo is only accessible through a secure API boundary.

## 1) View user data

### 1.1 General

**Purpose:** return the canonical user profile and his normalized photo without internal and secret data.

**Users/roles:**

- active user with `users@read` - viewing his own profile;
- active user with `users@read` and `users@read_any` - viewing someone else's profile;
- The role name is not involved in the decision; permissions are taken from the current RBAC.

**Unified catalog of permissions for working with users:**

|Resolution|Purpose|
| --- | --- |
| `users@read` |reading your own profile|
| `users@read_any` |additional access to someone else's profile|
| `users@update` |changing your own profile|
| `users@update_any` |additional permission to change someone else's user and directly change email by the administrator|
| `users@delete` |confirmed deletion of your own account|
| `users@delete_any` |additional permission to delete someone else's user by the administrator|
| `users@list` |viewing the administrative list of users|

The role `user` receives `users@read`, `users@update` and `users@delete` when transitioning to `active`. Actions `*_any` and `list` are not included in it.

**Dependencies/related settings:**

- authentication checks the access JWT from the cookie and only accepts an existing user with status `active`;
- authorization uses the chain access → current user → current RBAC → target resource → handler;
- RBAC stores the actions `read`, `read_any`, `update`, `update_any`, `delete`, `delete_any` and `list` of permission `users`;
- `PUBLIC_API_BASE_URL` specifies the HTTPS address from which `photoUrl` is formed;
- the photo storage implements read and delete operations using an opaque key; the key and storage details are not issued to the client;
- production uses S3-compatible object storage, the local file system is only allowed for one instance of the application in the development environment.

The canonical profile contains exactly `id`, normalized `email`, `displayName`, `photoUrl`, `status`, `createdAt`, `updatedAt`. The email in the allowed response is not masked. For `deleting` and `deleted`, the `photoUrl` field is equal to `null`, even if the internal key is still being cleared. `password_hash`, challenge secrets, JWT, roles, `photo_key`, service versions and internal fields are missing.

Valid user statuses: `pending`, `active`, `blocked`, `deleting`, `deleted`. Only `active` passes authentication. `deleting` means that the asynchronous deletion has been accepted and the tokens have already stopped working; `deleted` means that cleaning and anonymization are complete.

Changing your name and photo performs profile editing functionality. Removing objects and anonymizing is performed by the delete functionality. Viewing does not change the user row, photo object, JWT, or RBAC configuration.

### 1.2 User stories

1. **Own profile:** an active user with `users@read` requests his `userId` and receives a safe profile.
2. **Alien profile:** an active user with `users@read` and `users@read_any` requests someone else's `userId` and receives the same set of fields.
3. **No base permission:** the request ends with **403** before comparing with an existing record and before searching for the target.
4. **No additional right:** someone else's `userId` receives **403** before searching for the target, even if such user does not exist.
5. **No target:** a user with both required permissions receives **404** after the search is resolved.
6. **Photo set:** The client contacts `photoUrl`, goes through the same checks again and receives a normalized image.
7. **No photo:** resolved image request is received by **404** without disclosing the internal key.

### 1.3 Contract

#### 1.3.1 Obtaining a user profile

| `GET /users/{userId}` |Checks/validation|
| --- | --- |
| `userId: string` |From 1 to 128 ASCII characters, emails, numbers, `_` and `-` are allowed; the value is compared with the checked `actorUserId` without conversion|
| Cookie `access_token` |Verified entirely against the authentication contract; Only user `active` is accepted|

**Logic/steps:**

1. Check the format `userId`.
2. Check access JWT, get user by `sub` and accept only `active`. If refused, return **401** to RBAC.
3. Check the current `users@read`. If missing, return **403** without searching for the target user.
4. Compare `userId` with `actorUserId`.
5. If the identifiers are different, check the current `users@read_any`. If not available, return **403** without searching for the target.
6. After all the necessary permissions, select by `userId` only `id`, `email`, `display_name`, `photo_key`, `status`, `created_at`, `updated_at`.
7. If the row is missing, return **404**.
8. Create a safe profile. If `photo_key = null` or status `deleting` or `deleted`, return `photoUrl: null`, otherwise generate a protected API URL without the key itself.

**Answers:**

- **Success:** **200 OK** and `id`, `email`, `displayName`, `photoUrl`, `status`, `createdAt`, `updatedAt`.
- `displayName` is equal to `null` if the name is not specified; `photoUrl` is equal to `null`, if there is no photo or the status is equal to `deleting` or `deleted`.
- `email` is returned in full, already normalized and without masking.
- The response does not contain the password, `password_hash`, challenge, HMAC, JWT, cookies, roles, permissions, `photo_key`, local path, bucket address and internal fields.

#### 1.3.2 Getting a profile photo

| `GET /users/{userId}/photo` |Checks/validation|
| --- | --- |
| `userId: string` |Same format and comparison as getting a profile|
| Cookie `access_token` |Same active user verification chain|

**Logic/steps:**

1. Perform the steps of authentication, `users@read`, owner comparison and, if necessary, `users@read_any` before searching for the target.
2. Retrieve only `id`, `status` and `photo_key` of the target user.
3. If there is no user or photo or the status is `deleting` or `deleted`, return **404** without accessing the storage.
4. Read an object through the storage interface using the internal key.
5. Return normalized WebP bytes from `Content-Type: image/webp`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, max-age=300`.

If the string contains the key but the object is missing, the operation returns **503** because this is a consistency violation and not a "photo not set" condition. The event is sent to monitoring. The key, path, bucket name, original file name, and storage authorization headers are not included in the response.

#### 1.3.3 Canonical representation

|Field|Rule|
| --- | --- |
| `id: string` |immutable identifier|
| `email: string` |full normalized email; without trailing spaces, lowercase|
| `displayName: string \| null` |NFC, 1 to 80 code points after trimming; no control characters|
| `photoUrl: string \| null` |HTTPS URL of secure API operation; `null`, if there is no photo or the status is `deleting` or `deleted`|
| `status: string` |one of `pending`, `active`, `blocked`, `deleting`, `deleted`|
| `createdAt: string` |UTC date-time in RFC 3339 format|
| `updatedAt: string` |UTC date-time in RFC 3339 format|

The same form is used for the user's own, foreign, and administrative representation. Fields are not added by role name. A user with a status other than `active` cannot act as a caller, but a target with any of the five statuses is visible to the owner of the necessary permissions.

`displayName` is validated on write: `null` clears the name; the string is trimmed at the edges, normalized in NFC, and then must contain from 1 to 80 code points and not contain U+0000–U+001F or U+007F–U+009F. The view returns the saved value without re-correction.

#### 1.3.4 Photo storage limit

The application stores only the opaque object key in `users.photo_key`. Public `photoUrl` is calculated from `PUBLIC_API_BASE_URL`, `userId` and the fixed path; the client URL, local path and bucket address are not recorded in the database.

The storage interface provides operations `read(key)` and `delete(key)` with clear results `found`, `not_found` and `unavailable`. View only uses `read`. The implementation can be replaced without changing the HTTP contract and profile schema.

The photo object is a normalized WebP without animation or metadata. The loading check, conversion, atomic change `photo_key` and cleanup of the old object are determined by the profile change.

### 1.4 Errors and limitations

- **400 Bad Request** - `userId` does not comply with the format.
- **401 Unauthorized** - access is missing, invalid, expired, has invalid claims, or refers to an absent user or user not in the `active` state.
- **403 Forbidden** - active user does not have `users@read`; `users@read_any` is missing for someone else's identifier.
- **404 Not Found** - the target user was not found after all the necessary checks; the photo is not specified or is not available for status `deleting` or `deleted`.
- **429 Too Many Requests** - the set limit for reading a profile or photo has been exceeded.
- **503 Service Unavailable** - the user database, current RBAC snapshot or storage are unavailable; the row and the object of the photograph are mismatched.

The base permission check is performed before the resource lookup. For someone else's identifier, the additional `users@read_any` is also checked before the search. Therefore, **404** is received only by a user who is already allowed to read a target of this type.

### 1.5 Audit/logs

Log:

- successfully reading someone else's profile and photo;
- failure `users@read` or `users@read_any`;
- **404** after resolved search;
- rate limit triggered;
- unavailability of the database, RBAC and storage;
- mismatch between `photo_key` and the object.

The event contains `requestId`, `actorUserId`, type of operation, attribute `self` or `foreign`, `targetUserId` after being allowed to search, result and duration. For pre-search refusal, the operation path and entitlement category are stored without checking the existence of the target.

The log does not include email, `displayName`, `photoUrl`, photo bytes, `photo_key`, password, `password_hash`, challenge, JWT, `Cookie`, `Set-Cookie`, roles, full profile, full response body and entire request headers.

### 1.6 Non-functional requirements

- The user's own profile and photo allow no more than 120 user requests per minute, others - no more than 60. The next request receives **429**.
- The database query selects only the safe profile fields, and the photo query selects `id`, `status` and `photo_key`. The storage is read streamwise.
- Automated tests cover Self/alien profile, both permissions, permission order before search, all five statuses, and protected photo.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.5 Updating User Data — Practical task

_Source: [1.5 Updating User Data.md](<1.5 Updating User Data.md#practical-task>)_

Functionality for changing user data in the system.
Self changes the display name and photo, and the new email confirms the OTP or magic link with a valid session. An administrator with an additional `users@update_any` changes someone else's profile and email through a common PATCH. Unique indexes, transactions, and cleanup jobs determine the outcome of concurrent queries and partial failures.

## 1) Changing user data

### 1.1 General

**Purpose:** to safely change allowed profile fields, verified email and managed photo.

**Users/roles:**

- active user with `users@update` - changes his own `displayName` and photo, initiates and confirms his own email change;
- active user with `users@update` and `users@update_any` - changes someone else's profile;
- directly changing email via PATCH always requires `users@update_any`, regardless of whether `actorUserId` and `targetUserId` match;
- The role name is not a substitute for checking permissions.

**Unified catalog of permissions for working with users:**

|Resolution|Purpose|
| --- | --- |
| `users@read` |reading your own profile|
| `users@read_any` |additional access to someone else's profile|
| `users@update` |changing your own profile|
| `users@update_any` |additional permission to change someone else's user and directly change email by the administrator|
| `users@delete` |confirmed deletion of your own account|
| `users@delete_any` |additional permission to delete someone else's user by the administrator|
| `users@list` |viewing the administrative list of users|

**Dependencies/related settings:**

- access JWT and cookies fully comply with authentication: access is valid for 15 minutes, is in the HttpOnly cookie, and the server only accepts the current `active`;
- the protected operation pipeline corresponds to authorization: access → user → CSRF for cross-origin change → current RBAC → target → change;
- the general access control invariant considers only the user `active` to be the bearer of `rbac@manage` and serializes assignment changes, blocking, and deletion;
- `EMAIL_CHANGE_METHOD` has one server value `otp` or `magic_link`;
- `EMAIL_CHANGE_HMAC_KEY` contains a single random value of at least 32 bytes in length;
- SMTP and trusted frontend-origin are specified by the application configuration;
- the photo storage implements recording and deletion using opaque keys; production uses S3-compatible storage by default, local implementation is valid only for one instance of the application in development;
- background handler executes `storage_cleanup_jobs`: up to 5 attempts with a pause of 1 minute, `not_found` is considered a success.

If the required HMAC key is missing, empty, or shorter than 32 bytes, the application fails readiness. The JWT key, registration key, login challenge key and email change key are not combined.

The canonical profile contains exactly `id`, normalized `email`, `displayName`, `photoUrl`, `status`, `createdAt`, `updatedAt`. Email is not masked; for `deleting` and `deleted`, the common projector returns `photoUrl: null`, although edit operations do not succeed for these states. The responses do not contain `password_hash`, challenge secrets, HMAC, JWT, cookies, `photo_key`, roles or internal fields.

Acceptable statuses are `pending`, `active`, `blocked`, `deleting`, `deleted`; only `active` is authenticated. `deleting` and `deleted` are added for asynchronous deletion and are not set by edit operations.

### 1.2 User stories

1. **Self changes name:** the user sends only `displayName` and receives an updated safe profile.
2. **Self changes photo:** the user uploads one valid file, the server normalizes it and atomically switches the profile to the new object.
3. **Self clears the photo:** the link is deleted immediately, and the object is reliably cleared by a background job.
4. **Self changes email:** server sends OTP or magic link to the new address, and confirm with the same active session atomically changes email.
5. **Admin changes someone else's profile:** after `users@update` and `users@update_any`, the general PATCH accepts `displayName`, direct `email` and valid `status`.
6. **Admin changes the email directly:** PATCH from `users@update_any` does not create an email and consumes the previous self challenge of the target.
7. **Parallel email:** the only `UPDATE` that passes the unique index succeeds; the loser gets **409**.
8. **Partial failure:** The state of the user, challenge and objects remains unambiguous, and the response tells which request is safe to continue.

### 1.3 Contract

#### 1.3.1 Updating profile fields

| `PATCH /users/{userId}` |Checks/validation|
| --- | --- |
| `userId: string` |From 1 to 128 ASCII characters, emails, numbers, `_` and `-` are allowed|
| `displayName: string \| null` |Self and Admin allowed; `null` clears, the string is normalized and checked against name rules|
| `email: string` |Allowed only if `users@update_any` is present; normalized as during registration|
| `status: string` |Allowed only if `users@update_any` is present; total value only `active` or `blocked`|

The body contains from one to three unique fields from the table. Empty body, repeat key in JSON, unknown field and fields `id`, `photoUrl`, `createdAt`, `updatedAt`, `password`, `passwordHash`, roles or internal keys give **400**. `email: null` and `status: null` are not valid.

`displayName` after Unicode whitespace and NFC trimming contains from 1 to 80 code points and does not contain U+0000–U+001F or U+007F–U+009F. An empty string after trimming receives **400**; Only `null` is used for cleaning.

The email, after removing trailing spaces and converting emails to lowercase, must have a valid format and not exceed 254 characters. Tags `+tag` are saved. An address that matches the current one after normalization is considered a successful no-op.

**Logic/steps:**

1. Check the path format and JSON before accessing the database.
2. Check access, the current `active` and for a request from another origin the exact `Origin` with `X-CSRF-Protection: 1`, including with the same site location.
3. Check the current `users@update` before searching for a target.
4. If `userId` is different from `actorUserId`, check `users@update_any` before searching for the target.
5. If the body contains `email` or `status`, check `users@update_any`, even for your own purpose.
6. If `status = blocked` is requested, first obtain a shared policy state lock. Then find and block the user's row. The missing row gets **404**.
7. Allow changes only to targets in state `active` or `blocked`. For `pending`, `deleting` and `deleted`, return **409**.
8. Validate and normalize all values before recording.
9. Before the transition `active` → `blocked` under the general blocking of the RBAC invariant, make sure that after the transition there remains at least one other active user with `rbac@manage`. Otherwise, return **409** without changes.
10. One `UPDATE` change only the sent fields. Convert the unique `users.email` to **409**.
11. When directly changing the email, pay off the outstanding `email_change_challenges` of the target with the reason `admin_override` in the same transaction.
12. When going to `blocked`, pay off the outstanding login- and email-change challenges with the reason `user_inactive`. The following access and refresh stop working due to status checking.
13. If all normalized values already match, return the current profile without changing `updatedAt`; otherwise install a new server `updatedAt`.

**Answers:**

- **Success:** **200 OK** and the canonical safe profile.
- **Errors:** see section 1.4.
- The response does not contain the password, hash, challenge, JWT, cookies, roles, `photo_key`, previous values and internal fields.

#### 1.3.2 Initiation and resend of email changes

|Operation|Inputs and rules|
| --- | --- |
| `POST /users/{userId}/email-change` |`newEmail: string`; only Self with `users@update`|
| `POST /users/{userId}/email-change/resend` |`challengeId: string`; only Self with `users@update`, method and address do not change|

`newEmail` is normalized according to the same rules as the registration email. The current address and the address already occupied by the row `users` receive **409**. The server selects the method from `EMAIL_CHANGE_METHOD`; the client does not send `method`.

**Initiation logic:**

1. Check access, current `active`, CSRF if necessary and `users@update`.
2. Compare `userId` with `actorUserId`. Mismatch return as **403** before searching for target record; Admin uses direct PATCH.
3. Block the user's row, then his outstanding challenge in the general blocking order; normalize `newEmail` and check the current state.
4. If an outstanding challenge was created or sent less than 60 seconds ago, return **429** with the remaining time.
5. After a pause, in one transaction, consume the previous challenge as `replaced` and create a new one with the selected method, a new HMAC and `attempts = 0`.
6. Commit the transaction, then send the secret only to `newEmail`.

**Logic resend:**

1. Repeat access, `active`, CSRF, `users@update` and Self, block the user, then challenge `challengeId` and `user_id`.
2. Not found, replaced, already confirmed or consumed as a `user_inactive` challenge receives **400**; `attempts_exhausted` receives **429**; `admin_override` and `email_conflict` receive **409**.
3. If 60 seconds have not passed with `last_sent_at`, return **429** with the remaining time.
4. Create a new secret using the same method, replace `secret_hash`, update `last_sent_at` and reset `attempts` in one transaction.
5. After fixing, send an email. The previous OTP or token immediately ceases to be suitable.

If the transaction is not committed, the email is not sent, the state does not change and **503** is returned. If SMTP did not accept the email after committing, the challenge is saved, and **503** contains `confirmationRequired: true`, `method`, `challengeId`, `retryAfterSeconds`, but not a secret. The replay is performed via resend after a total pause of 60 seconds.

**Answers:**

- **Accepted:** **202 Accepted**, `confirmationRequired: true`, `method`, `challengeId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`.
- **SMTP unavailable after commit:** **503 Service Unavailable** with the same safe fields and `retryAfterSeconds`.
- OTP, link token, HMAC, current and new email, JWT and cookies are missing in JSON.

#### 1.3.3 Confirmation of email change

| `POST /users/{userId}/email-change/confirm` |Input data|
| --- | --- |
| OTP |`challengeId: string`, `code: string` of exactly 6 digits|
| Magic link |`token: string` in the format `challengeId.secret`, where secret contains 32 random bytes up to base64url; the email sends the token in the URL fragment|

The body contains exactly one variant. GET on a link does not change the state; the client page retrieves the token and sends a POST with a valid cookie.

**Logic/steps:**

1. Check access, current `active`, CSRF, `users@update` and the match of `userId` with `actorUserId`.
2. Block the user, then find and block the challenge in the same order as initiation, resend, PATCH and deletion.
3. Ensure that the challenge belongs to the user and has the expected method. Not found, replaced, already confirmed or consumed as a `user_inactive` challenge receives **400**; `attempts_exhausted` receives **429**; `admin_override` and `email_conflict` receive **409**.
4. Define overdue as `last_sent_at + 10 minutes`. An expired challenge receives **400** without increasing `attempts`.
5. Recheck that the user is still `active`. When changing the status, consume the challenge as `user_inactive` and return **401 invalid_session**.
6. Calculate HMAC-SHA256 of the secret and compare in constant time.
7. For an incorrect OTP, increase `attempts`. The fifth input is checked; the fifth incorrect one gets **400** and `attempts_exhausted`, the next request gets **429**. An incorrect magic link receives **400** without a counter.
8. If there is a match, try to change `users.email` and `updated_at` under a unique index.
9. In case of a unique conflict, roll back only `UPDATE` to the rollback point, consume the challenge as `email_conflict`, fix this state and return **409**.
10. If successful, consume the challenge as `confirmed` in the same transaction and return the safe profile.

If the entire transaction is rolled back, the challenge remains retryable and **503** is returned. If the commit is successful, but the response is lost, the email has already been changed; retry receives an consumed challenge error, and the current value is returned by reading the profile.

**Answers:**

- **Success:** **200 OK** and the canonical safe profile with a new normalized email.
- **Errors:** see section 1.4.
- The response does not contain OTP, link token, HMAC, old email, JWT, cookies or internal fields.

#### 1.3.4 Uploading a photo

| `PUT /users/{userId}/photo` |Checks/validation|
| --- | --- |
| `file` |exactly one multipart file; JPEG, PNG or WebP; no more than 5 MiB|
|Other multipart fields|prohibited|

Self requires `users@update`; for someone else's `userId`, an additional `users@update_any` is required before searching for the target. The target must have status `active` or `blocked`; `pending`, `deleting` and `deleted` receive **409**.

**File rules:**

1. Stop reading after 5 MiB and return **413**.
2. Compare the declared MIME, signature and decoding result. An unsupported container gets **415**, corrupted content gets **400**.
3. Accept exactly one non-animated frame from 64×64 to 4096×4096 pixels.
4. Apply EXIF orientation, maintain aspect ratio and reduce to 1024×1024 frame without enlarging the small image.
5. Remove all metadata and re-encode one WebP no larger than 2 MiB. Failure to meet the limit gives **400**.
6. Generate an opaque key of at least 128 random bits; Do not put the original name and `userId` in the key.

**Save logic:**

1. Perform the protected operation pipeline and file validation.
2. Write the normalized object under the new key. Until success, the database does not change.
3. Block the user, recheck the valid status, and begin the transaction.
4. Replace `photo_key`, update `updated_at` and, if there was an old key, create `storage_cleanup_jobs` with reason `photo_replaced`.
5. Commit the transaction and return a new safe profile.

If loading an object fails, **503** is returned and the previous profile is not changed. If an object is written but the transaction is rolled back, the server tries to delete a new object; The periodic collector removes the remaining unacknowledged object older than one hour. If the transaction is successful, a subsequent error deleting the old object does not change the response: cleanup job repeats the deletion up to five times, then moves to `failed`.

**Answer:** **200 OK** and safe profile with the new protected `photoUrl`. Bytes, original name, metadata, object key, path and storage details are not included in JSON and the log.

#### 1.3.5 Cleaning up a photo

| `DELETE /users/{userId}/photo` |Rule|
| --- | --- |
|Body missing|Self requires `users@update`, someone else's target additionally requires `users@update_any`|

After the permissions, the server blocks the user's row. For `pending`, `deleting` and `deleted`, **409** is returned. If `photo_key` is already equal to `null`, the operation returns **204** without changing `updatedAt`.

If a photo is set, a single transaction sets `photo_key = null`, updates `updated_at`, and creates a cleanup job with the reason `photo_cleared`. After the transaction commits, return **204 No Content**. Storage unavailability does not restore the reference: background cleanup retries deletion up to five times, and `not_found` counts as success.

The response does not contain the body, the former `photoUrl`, object key, JWT, cookies or internal data.

#### 1.3.6 Canonical profile and status boundaries

Each successful JSON response contains only:

- `id`;
- full normalized `email`;
- `displayName: string | null`;
- protected `photoUrl: string | null`;
- `status`;
- `createdAt`;
- `updatedAt`.

Self modifies `displayName` via PATCH, photo via separate operations and email via challenge. Admin with `users@update_any` modifies `displayName`, normalized email and `active`/`blocked` via PATCH, and a photo via the same file operations.

`pending` is registration controlled. `deleting` is set immediately when deletion is accepted, `deleted` is set after anonymization. Editing these states does not bypass or undo them.

The shared projector installs `photoUrl: null` for `deleting` and `deleted`, even if the internal `photo_key` still needs a removal worker. Successful edit responses only return `active` or `blocked`.

### 1.4 Errors and limitations

- **400 Bad Request** - invalid path, JSON or multipart; unknown or duplicate field, empty PATCH, multiple files or extra multipart; invalid `displayName` or email; damaged, animated, too small, too large after decoding, or image that does not fit into the final limit; invalid challenge format, incorrect or expired secret, not found, replaced, already confirmed or consumed as `user_inactive` challenge.
- **401 Unauthorized** - access is missing, invalid, expired, or refers to an absent or inactive user; status changed to critical commit confirm.
- **403 Forbidden** - missing `users@update`; foreign target or direct email not allowed `users@update_any`; Self passed `email` or `status` to PATCH; cross-origin CSRF check failed.
- **404 Not Found** - The target user was not found after all required permissions.
- **409 Conflict** - email is already in use during preliminary or final verification; when you initiate an email change, the new address coincides with the current one; the target has `pending`, `deleting` or `deleted`; challenge is consumed with reason `admin_override` or `email_conflict`; locking would leave the system without an active user with `rbac@manage`. The address match in the administrative PATCH remains a successful no-op and receives **200**.
- **413 Content Too Large** - the multipart file exceeds 5 MiB.
- **415 Unsupported Media Type** - the container is not JPEG, PNG or WebP, or the declared MIME does not correspond to a supported format.
- **429 Too Many Requests** - change rate limit exceeded; the email was requested before 60 seconds; OTP has already exhausted five inputs.
- **503 Service Unavailable** - the database, current RBAC, SMTP, storage or transaction record are unavailable; the partial failure condition is described in the operation.

The base permission is checked before the user is searched. For a foreign target, `users@update_any` is also checked before the search. Therefore, a client without permissions receives **403**, and **404** is possible only after admission to the target.

### 1.5 Audit/logs

Log:

- successful and rejected PATCH with `actorUserId`, `targetUserId`, field names and result;
- transition `active` ↔ `blocked`;
- creation, resend, invalid input, delay, conflict and successful confirmation email challenge;
- uploading, replacing and clearing a photo without file content and object key;
- creating, repeating and completing storage cleanup;
- conflicts of a unique index, rate limit and unavailability of dependencies.

The names of the changed fields are recorded, but their old and new values are not. For challenge, `challengeId`, method, event and result are stored, but not the destination address. For cleanup, the object's foreign key is replaced by the internal job ID in the regular log; the key itself is only accessible to a restricted handler.

The log does not include email, `displayName`, photo, metadata, local path, `photo_key`, password, `password_hash`, OTP, magic-link token, HMAC, JWT, `Cookie`, `Set-Cookie`, application keys, full URL, full request body, multipart and full headers.

### 1.6 Non-functional requirements

- PATCH and photo operations allow a maximum of 30 user change requests per hour. Email challenge: resend pause 60 seconds and no more than 5 emails per user per hour. The next challenge gets **429**.
- Changes to a user's row are made by the transaction; The uniqueness of the email is ensured by the database, the conflict is **409**. One outstanding email challenge per user sets a partial unique index.
- Cleanup worker processes `queued` jobs with `next_attempt_at` occurring, repeats the failure up to 5 times with a pause of 1 minute and considers `not_found` a success. Periodic reconciliation removes unverified objects older than one hour without affecting the keys from `users.photo_key`.
- Automated tests cover whitelist fields, Self/Admin, email race, fifth OTP, changing and clearing photos, cleanup and protection of the last active `rbac@manage`.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.6 Deleting a User — Practical task

_Source: [1.6 Deleting a User.md](<1.6 Deleting a User.md#practical-task>)_

Functionality for deleting a user in the system.
Self confirms the current email and starts asynchronous deletion with a valid session; Admin starts deleting someone else's user directly. Accept immediately sets `deleting`, returns **202** and client-known `jobId`, and the idempotent worker clears the PII and files, anonymizes the main row and ends it with the status `deleted`.

## 1) Removing a user

### 1.1 General

**Purpose:** to irreversibly clear the user's personal data with immediate termination of access, monitored status and safe retry.

**Users/roles:**

- active user with `users@delete` - initiates a challenge and confirms deletion of his own account;
- active user with `users@delete` and `users@delete_any` - directly triggers the deletion of someone else’s account;
- own `userId` cannot be deleted by the administrative endpoint even with `users@delete_any`;
- Self receives status after losing a session using an opaque receipt `jobId`;
- active Admin receives alien target status only with `users@delete` and `users@delete_any`.

**Unified catalog of permissions for working with users:**

|Resolution|Purpose|
| --- | --- |
| `users@read` |reading your own profile|
| `users@read_any` |additional access to someone else's profile|
| `users@update` |changing your own profile|
| `users@update_any` |additional permission to change someone else's user and directly change email by the administrator|
| `users@delete` |confirmed deletion of your own account|
| `users@delete_any` |additional permission to delete someone else's user by the administrator|
| `users@list` |viewing the administrative list of users|

**Dependencies/related settings:**

- access, refresh and cookies correspond to authentication; each token is accepted only for an existing user `active`;
- the protected operation pipeline corresponds to authorization and current RBAC;
- the general access control invariant considers only the user `active` to be the bearer of `rbac@manage` and serializes assignment changes, blocking, and deletion;
- assigning roles to a user re-checks its status under general blocking and rejects `deleting` or `deleted`;
- `DELETION_CONFIRMATION_METHOD` has one value, `otp` or `magic_link`, which is selected by the server;
- `DELETION_CHALLENGE_HMAC_KEY` contains a single random value of at least 32 bytes in length;
- SMTP sends a challenge to Self's current email;
- worker receives durable jobs from the database, applies lease and calls registered eraser;
- profile storage and future modules provide idempotent cleanup;
- `DELETION_WORKER_LEASE_SECONDS` is 300 by default, the maximum number of automatic starts is 5, the pause between them is 1 minute.

If the key is missing, empty, or shorter than 32 bytes, the application fails readiness. The key does not match the JWT, registration, login or email-change key.

The canonical profile in all user operations contains `id`, normalized `email`, `displayName`, `photoUrl`, `status`, `createdAt`, `updatedAt`. Email is not masked. With `deleting`, the `photoUrl` field is already equal to `null`; after anonymization, the email becomes a random tombstone, `displayName` is also equal to `null`, and `status` is equal to `deleted`. `password_hash`, challenge secrets, JWT, object keys and internal fields are not issued.

The statuses are agreed as `pending`, `active`, `blocked`, `deleting`, `deleted`; only `active` is authenticated. `deleting` is added as an immediate barrier during asynchronous cleanup, `deleted` is added as a completed anonymized state.

### 1.2 User stories

1. **Self confirms the deletion:** the server sends an OTP or magic link to the current email, and confirm with an active session creates a job.
2. **Admin deletes someone else's user:** a request with both permissions creates a job without an email.
3. **Access is terminated:** in the acceptance transaction the user becomes `deleting`, so the next access and refresh receive **401**.
4. **The client monitors the process:** Self presents the previously created `jobId`, and Admin passes both delete permissions; the answer contains `queued`, `running`, `succeeded`, or `failed`.
5. **Repeat request:** same process and `jobId` returned without a second deletion and a second tombstone.
6. **Temporary failure:** worker calls all idempotent eraser again, user remains `deleting`.
7. **Complete success:** files and PII are cleared, the main row is anonymized, the old email is released, the status becomes `deleted`.
8. **Permanent failure:** job becomes `failed`, and the administrator repeats DELETE the same job into the queue.

### 1.3 Contract

#### 1.3.1 Initiation and resend of self-confirmations

|Operation|Inputs and rules|
| --- | --- |
| `POST /users/{userId}/deletion-challenge` |the body is missing; only Self with `users@delete`|
| `POST /users/{userId}/deletion-challenge/resend` |`challengeId: string`; only Self with `users@delete`|

`userId` contains from 1 to 128 ASCII characters of emails, numbers, `_` and `-`. The server selects a method from `DELETION_CONFIRMATION_METHOD` and sends an email to the current email; the client `method` does not transmit the address.

**Initiation logic:**

1. Check access, current `active`, CSRF for a request from another origin, regardless of the site and `users@delete` boundaries.
2. Compare `userId` with `actorUserId`. Return mismatch as **403** before searching for target.
3. Block the user, then his outstanding deletion challenge and existing deletion job in the general order. If job already exists, return **409** and do not send the email.
4. If the outstanding challenge was sent less than 60 seconds ago, return **429** with the remaining time.
5. After a pause, consume the previous challenge as `replaced` and create a new one of the selected method with `attempts = 0` in one transaction.
6. Capture the challenge, then send the secret to the current normalized email.

**Logic resend:**

1. Repeat access, `active`, CSRF, `users@delete` and Self, block the user, then challenge `challengeId`.
2. Not found, replaced, already confirmed or consumed as a `user_inactive` challenge receives **400**; `attempts_exhausted` receives **429**; `job_exists` receives **409**.
3. If 60 seconds have not passed since `last_sent_at`, return **429**.
4. Create a new secret in the same way, replace HMAC, update `last_sent_at` and reset `attempts` in one transaction.
5. After fixing, send an email; the old secret no longer applies.

If the transaction is not committed, the email is not sent and **503** is returned. If SMTP did not accept the email after committing, the challenge is saved, and **503** contains `confirmationRequired`, `method`, `challengeId` and `retryAfterSeconds`, but not the email and secret.

**Answers:**

- **Accepted:** **202 Accepted**, `confirmationRequired: true`, `method`, `challengeId`, `expiresInSeconds: 600`, `resendAfterSeconds: 60`.
- There are no OTP, token, HMAC, email, JWT, cookies and profile data in JSON.

#### 1.3.2 Confirming Self and accepting deletion

| `POST /users/{userId}/deletion-confirm` |Input data|
| --- | --- |
|Header `Idempotency-Key`|exactly 32 lowercase hexes created by the client from 16 random bytes; the value becomes `jobId`|
| OTP |`challengeId: string`, `code: string` of exactly 6 digits|
| Magic link |`token: string` in the format `challengeId.secret`, secret contains 32 random bytes up to base64url; the email sends the token in the URL fragment|

The body contains exactly one variant of the secretion. GET via magic link does not change the state.

**Logic/steps:**

1. Check path, `Idempotency-Key` and body shape.
2. Before a new business operation, check the idempotent retry: if such `jobId` already belongs to the same user, return it with **202** without re-checking the challenge; if the key refers to a different target, return **409**. This branch does not create or repeat jobs.
3. If there is no job with such a key, check access, the current `active`, CSRF, `users@delete` and whether `userId` matches `actorUserId`.
4. Obtain a general policy state lock, then lock the user and challenge in the established order of transactional locks.
5. Check ownership, method, consumption status, and TTL `last_sent_at + 10 minutes`. Not found, replaced, already confirmed or consumed as a `user_inactive` challenge receives **400**; `attempts_exhausted` receives **429**; `job_exists` receives an existing job with **202**.
6. Recheck `active`; with a different status, consume the challenge as `user_inactive` and return **401**.
7. Compare constant time HMAC. The fifth OTP is still being verified; the fifth incorrect one receives **400** and consumes the challenge, the next one receives **429**. An incorrect magic link receives **400** without a counter.
8. If the user already has a job with a different key, consume the challenge as `job_exists` and return the existing job with **202**.
9. If the user is assigned `rbac@manage`, under the already acquired RBAC invariant lock, ensure that another active bearer remains. Otherwise, return **409** without job and without status transition.
10. Create `deletion_jobs` with status `queued`, `attempts = 0` and `next_attempt_at = now` and generate one tombstone.
11. Set the user to `deleting`, delete it as `user_roles`, increase `rbac_policy_state.version`, update `updated_at`, clear the challenge as `confirmed` and clear the rest of the login-, email-change- and deletion-challenge in one transaction.
12. Commit the transaction, send the client the expired access and refresh cookies with the original attributes and return a receipt.

If the transaction is rolled back, the user remains `active`, the challenge is suitable for retry, there is no job and **503** is returned. After committing, `jobId` is already known to the client from the header, so the lost response does not interfere with checking the status.

**Answer:** **202 Accepted**, `jobId`, `status`, `statusUrl`. `statusUrl` contains only the path `/users/{userId}/deletion-status`, without a receipt in path or query; Self transmits it later only to `Deletion-Receipt`. When you first accept `status = queued`; when repeated, the current status of the existing job is returned. The response does not contain a profile, email, challenge secret, JWT, tombstone or internal fields.

#### 1.3.3 Administrative acceptance of deletion

| `DELETE /users/{userId}` |Checks/validation|
| --- | --- |
| `userId: string` |1 to 128 ASCII characters of emails, numbers, `_` and `-`|
|Header `Idempotency-Key`|32 lowercase hex of 16 random bytes; the value becomes `jobId`|
|Body|missing|

**Logic/steps:**

1. Check path and header.
2. Check access, current `active`, CSRF and basic `users@delete`.
3. If `userId` matches `actorUserId`, return **403 Forbidden** with code `self_confirmation_required`; your own account can only be deleted through a challenge.
4. Check `users@delete_any` before searching for a target.
5. If `jobId` already belongs to another target, return **409**.
6. Obtain a general policy state block, then find and block the target user. After both permissions, the absence receives **404**.
7. After the user, block the existing job, if there is one, and return **202** with its `jobId`. For `failed`, transfer the same job to `queued`, set `next_attempt_at` to the current time, reset `attempts` and clear lease and `last_error_code`; Do not create a new tombstone.
8. If the target status is `active` or `blocked` and it is assigned `rbac@manage`, under general RBAC invariant blocking, ensure that another active carrier remains. Otherwise, return **409** without changes.
9. If the target status is `pending`, `active` or `blocked`, create a job and tombstone with `next_attempt_at` occurring, set `deleting`, delete `user_roles` targets and increase `rbac_policy_state.version` in one transaction.
10. If the status is `deleting` or `deleted`, but there is no associated job, return **503** and a consistency violation event.
11. Clear all challenge goals upon first acceptance.

**Answer:** **202 Accepted**, `jobId`, current `status`, `statusUrl` without a receipt in path or query. Email challenge is not created. The response does not contain target profile, email, password hash, JWT, tombstone, actor roles or internal fields.

#### 1.3.4 Deletion status

| `GET /users/{userId}/deletion-status` |Checks/validation|
| --- | --- |
| Self |The header `Deletion-Receipt` contains `jobId` of 32 lowercase hex; auth-cookie and body are not used|
| Admin |Valid access, `users@delete` and `users@delete_any`; `userId` must be different from `actorUserId`; body is missing|

The operation is declared as a receipt operation using `Deletion-Receipt` along with the base pair `users@delete`. If there is a header, the Self-branch is executed and the cookie is not read, even when it is also sent. If there is no header, the Admin branch is executed: access and `users@delete`, then `users@delete_any` before searching for the target. The operation is not marked public.

The self branch is available after the session is lost because `deleting` is no longer authenticated. The server finds the job from the receipt and checks the exact match of `job.user_id` with `userId` from the path. Mismatch and unknown receipt receive the same **404**. The receipt only allows reading the minimum status and does not start or repeat a job.

The Admin branch first fully checks access and the current `active`, then `users@delete` and `users@delete_any` before searching for someone else's target. Self `userId` receives **403** and uses the Self branch. The missing target or job after both permissions receives **404**.

**Answers:**

- **Found:** **200 OK**, `jobId`, `status`, `createdAt`, `updatedAt`, `finishedAt`.
- `status` has one value `queued`, `running`, `succeeded` or `failed`; `finishedAt` is specified only for `succeeded`.
- **Not Found:** **404 Not Found** for unknown target, job, invalid receipt or mismatch between receipt and target after appropriate checks.
- The response does not contain `userId`, actor, email, name, photo, reason for deletion, tombstone, external service error, number of attempts, PII, JWT and internal fields.

Endpoint does not make decisions about accessing other data and does not allow the job to be repeated. Rate limit, receipt randomness and Admin check protect massive search; successful and unsuccessful searches do not reveal user data.

#### 1.3.5 Worker and mandatory eraser

Worker processes `queued` and `running` with expired lease:

1. Atomically get a job with the status `queued` and `next_attempt_at <= now` or `running` with an expired lease, set `running`, `lease_until = now + 300 seconds`, clear `next_attempt_at` and increase `attempts`.
2. Call each registered `eraseUserData(userId, deletionJobId)` in turn.
3. If all erasers returned `succeeded`, perform the final anonymization from section 1.3.6.
4. If any eraser returned `retryable_failure` and `attempts` less than 5, save the safe code, return job to `queued`, clear lease and write `next_attempt_at = now + 1 minute`.
5. If `attempts` reaches 5 or the result is `permanent_failure`, set job `failed`, clear lease and `next_attempt_at`; the user remains `deleting`.
6. If the final transaction does not commit, treat this as `retryable_failure` with the same retry limit and delay; the original **202** response remains unchanged.

Each module with user data must register eraser before receiving such data. The interface accepts only `userId` and `deletionJobId`, idempotently removes module-owned PIIs and objects, and returns `succeeded`, `retryable_failure`, or `permanent_failure` with safe code. Calling again after success returns `succeeded` again.

Part 2 with transformations is required to delete the source and result files and clean up or anonymize their records through this interface. Specific tables, fields, formats, and object locations are not specified here. Without a registered eraser readiness transformation module, the transformation does not work.

#### 1.3.6 Final anonymization

After all successes, eraser worker executes one transaction:

1. Locks the state of the policy, user, then job. The pair `job.status = succeeded` and `user.status = deleted` immediately gives internal idempotent success; otherwise `job.status = running` and `user.status = deleting` are required.
2. Re-check that the profile photo has been deleted or is missing.
3. Physically deletes registration-, login-, email-change- and deletion-challenge of the user.
4. Idempotently removes remaining `user_roles`; if rows are actually deleted, increment `rbac_policy_state.version`.
5. Installs `email = tombstone_email`, `display_name = null`, `photo_key = null`, `password_hash = null`, `status = deleted`, new `updated_at`.
6. Sets job to `succeeded`, sets `finished_at` and clears lease and `next_attempt_at`.

The database constraint allows `password_hash = null` only when `status = deleted` and requires `display_name = null`, `photo_key = null` in this state. The unique tombstone looks like `deleted.<32 lowercase hex>@example.invalid` and is not derived from the original email.

The old email is released after this transaction is committed. The row `users` and its `id`, `created_at`, `updated_at` are preserved to prevent foreign keys from becoming dangling references. A new registration of the previous email creates a new `id` and does not receive the old roles, files or history.

Repeating the finalization for already `deleted` and `succeeded` returns internal success without new changes. Status endpoint then returns `succeeded`.

### 1.4 Errors and limitations

- **400 Bad Request** - invalid `userId`, `jobId`, `Idempotency-Key`, challenge body, OTP or magic link; challenge not found, expired, replaced, already confirmed or consumed as `user_inactive`.
- **401 Unauthorized** - access is missing, invalid, expired or refers to a user not in the `active` state; Self lost active before accepting the job.
- **403 Forbidden** - missing `users@delete`; administrative foreign target is missing `users@delete_any`; direct DELETE or Admin status check is directed at the own user; CSRF check failed.
- **404 Not Found** - the target user or job was not found after the required permissions; The self-receipt is unknown or refers to a different purpose.
- **409 Conflict** - `Idempotency-Key` already refers to a different target; challenge is initiated or resent after an already created job; deletion would leave the system without an active user with `rbac@manage`.
- **429 Too Many Requests** - rate limit exceeded; resend completed before 60 seconds; OTP has already exhausted five inputs.
- **503 Service Unavailable** - the database or current RBAC are unavailable before acceptance or when reading the status; SMTP is not available when sending a challenge; mandatory eraser configuration is not ready; detected `deleting`/`deleted` without job; the acceptance transaction is not recorded. Failure of a store, worker, or final transaction after committed **202** is reflected in the status of the existing job and does not change the acceptance response.

The base permission is checked before the target is searched. For someone else's administrative deletion, `users@delete_any` is also checked before the search, so a client without permission always receives **403**, and **404** is only possible after admission.

Job with status `failed` does not mean a rollback. The user remains `deleting`, access and refresh do not work, automatic restoration of PII or status is prohibited.

### 1.5 Audit/logs

Log:

- creation, resend, incorrect entry, delay and repayment deletion challenge;
- accepting self/admin, idempotent replay and key conflict;
- user transition to `deleting` and final `deleted`;
- claim, success, retry and permanent failure job;
- administrative repeat `failed` job;
- violation of consistency and completion of anonymization.

The event contains the type of operation, a secure result code, and a time. The log does not include `jobId`, `Idempotency-Key`, `Deletion-Receipt`, actorUserId, targetUserId, email, displayName, IP, reason, tombstone, OTP, magic-link token, HMAC, JWT, cookies, storage keys, file contents, full request body and full headers.

### 1.6 Non-functional requirements

- Creating a deletion challenge allows no more than 5 emails per user per hour; resend has a pause of 60 seconds. Status endpoint allows 60 requests from IP per minute. The next challenge gets **429**.
- The accept transaction atomically creates a job, installs `deleting`, deletes `user_roles`, increases the RBAC version and consumes the challenge. Worker reads jobs from the database and does not depend on an external broker.
- Unique restrictions cover `deletion_jobs.id`, one job per `user_id`, tombstone and one outstanding challenge per user. The claim index covers `status, next_attempt_at, lease_until`.
- The worker holds the lease for 5 minutes, repeats the temporary failure up to 5 times with a pause of 1 minute and experiences a process stop. Each eraser is idempotent; the absence of an object in storage is considered a success.
- Readiness fails if the module stores user data without eraser.
- Automated tests cover Self/Admin, both status branches, prohibition of direct self-delete, protection of the last active `rbac@manage`, loss of **202**, repeat eraser, `failed`, tombstone and re-registration of old email.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to these operations.


---

# 1.7 Listing All Users — Practical task

_Source: [1.7 Listing All Users.md](<1.7 Listing All Users.md#practical-task>)_

Functionality to view a list of all users in the system.
An active user with `users@list` receives canonical safe profile pages via `GET /admin/users`. Search, filter and sorting are limited to the whitelist, the page size has a fixed default and maximum, and the signed compound cursor binds an immutable order to the parameters of the first request.

## 1) View a list of all users

### 1.1 General

**Purpose:** to return stable safe profile pages with limited search and filtering to the privileged user.

**Users/roles:**

- active user with `users@list` - receives the list;
- an active user without `users@list` receives **403**;
- the role name `admin` is not checked, the decision is made by the current RBAC;
- statuses of target users do not limit presence in the list.

**Unified catalog of permissions for working with users:**

|Resolution|Purpose|
| --- | --- |
| `users@read` |reading your own profile|
| `users@read_any` |additional access to someone else's profile|
| `users@update` |changing your own profile|
| `users@update_any` |additional permission to change someone else's user and directly change email by the administrator|
| `users@delete` |confirmed deletion of your own account|
| `users@delete_any` |additional permission to delete someone else's user by the administrator|
| `users@list` |viewing the administrative list of users|

**Dependencies/related settings:**

- access JWT and cookies fully comply with authentication; only existing actor with status `active` passes to RBAC;
- `users@list` is checked against the current version of the policy before users query;
- `USER_LIST_CURSOR_ACTIVE_KEY_ID` selects the active `kid`, and `USER_LIST_CURSOR_HMAC_KEYS` contains a key ring of individual random values of at least 32 bytes in length;
- default `limit` is equal to 20, maximum is equal to 100;
- cursor is valid for 15 minutes from `snapshotAt`;
- `users.created_at` is assigned the database UTC clock and does not change once created;
- `PUBLIC_API_BASE_URL` generates protected `photoUrl` without reading the storage.

If the active `kid` is not found, any cursor key is empty or shorter than 32 bytes, or two `kid` are repeated, the application fails readiness. The keys do not match the JWT and challenge keys, are not in the code and are not returned to the client. During rotation, the previous key is stored for at least 15 minutes 30 seconds and then deleted.

The canonical element contains exactly `id`, normalized `email`, `displayName`, `photoUrl`, `status`, `createdAt`, `updatedAt`. The email is returned in full and is never masked at this endpoint. `password_hash`, challenge secrets, JWT, cookies, roles, `photo_key`, deletion job and internal fields are missing.

The statuses are agreed as `pending`, `active`, `blocked`, `deleting`, `deleted`; only `active` is authenticated as actor. All five values are allowed in items. `deleting` means accepted cleaning and always has `photoUrl: null`; `deleted` - completed anonymization with tombstone email and empty name and photo.

### 1.2 User stories

1. **First page:** client without cursor gets up to 20 users in order `createdAt desc, id desc`.
2. **Next page:** the client passes `nextCursor` and unchanged parameters, receives continuation without repetitions at the same creation time.
3. **Limited search:** client selects exactly one field `id`, `email` or `displayName`; email and name prefix contains at least three characters.
4. **Status filter:** the client selects one of five canonical states.
5. **Allowed sorting:** the client selects `createdAt` or `id` and the direction `asc` or `desc`.
6. **Invalid cursor:**, a changed signature, an expired TTL or mismatched parameters receive **400**.
7. **No right:** request receives **403** before searching, sorting and reading users.
8. **End of traversal:** last page returns `nextCursor: null`; separate `totalCount` is not calculated.

### 1.3 Contract

#### 1.3.1 Getting a list

| `GET /admin/users` |Rule|
| --- | --- |
| `cursor` |missing from the first page; on the following ones contains an opaque string issued by the server|
| `limit` |integer from 1 to 100; if absent, equals 20|
| `searchBy` |missing with `q` or has `id`, `email` or `displayName`|
| `q` |present only with `searchBy`; format depends on the selected field|
| `status` |if available, one of `pending`, `active`, `blocked`, `deleting`, `deleted`|
| `sort` |`createdAt` or `id`; in the absence of `createdAt`|
| `order` |`asc` or `desc`; in the absence of `desc`|

Other query parameters and repetition of one parameter receive **400**. When transmitting cursor `limit`, `searchBy`, `q`, `status`, `sort` and `order` must match the first page after normalization.

**Search validation:**

- `searchBy=id` - `q` contains from 1 to 128 ASCII characters of emails, numbers, `_` and `-`; an exact comparison is made;
- `searchBy=email` - `q` after trimming and lower case contains from 3 to 254 visible ASCII characters without spaces or control characters; literal prefix is executed, SQL wildcard is not interpreted;
- `searchBy=displayName` - `q` after trimming and NFC contains from 3 to 80 code points without U+0000–U+001F and U+007F–U+009F; the database compares the literal prefix through `lower(normalize(display_name, NFC))`;
- empty `q`, `q` without `searchBy` and `searchBy` without `q` get **400**.

**Logic/steps:**

1. Check access JWT, get user by `sub` and accept only `active`. If refused, return **401** to RBAC.
2. Check the current `users@list`. If missing, return **403** before validating the search and query `users`.
3. Reject unknown, duplicate and invalid query parameters.
4. On the first page, get `snapshotAt` from the database UTC hours before sampling and normalize the query.
5. On the next page check the format, `kid`, HMAC, version, TTL and `queryTag` cursor.
6. Build only the server version of the parameterized keyset query and the condition `created_at < snapshotAt`.
7. Select `limit + 1` rows and only `id`, `email`, `display_name`, `photo_key`, `status`, `created_at`, `updated_at`.
8. Pass no more than `limit` lines through safe projector.
9. If there is an extra row, sign cursor by the last returned element; otherwise return `nextCursor: null`.

The database request has a timeout of 2 seconds. The timeout expires and returns **503**, not a partial page. No SQL fragment, arbitrary column name, or operator from the client is substituted into the query.

**Answer:**

- **200 OK:** `items: SafeProfile[]`, `nextCursor: string | null`.
- `items` contains from 0 to `limit` elements.
- An empty first or next page is acceptable and returns `nextCursor: null`.
- `totalCount`, page number and previous cursor are not returned.

#### 1.3.2 Composite cursor

Payload contains:

|Field|Meaning|
| --- | --- |
| `v` |format version `1`|
| `kid` |identifier of the key with which cursor is signed|
| `sort` |`createdAt` or `id`|
| `order` |`asc` or `desc`|
| `snapshotAt` |RFC 3339 UTC from database clock before first fetch|
| `lastSortValue` |last value of the selected immutable field|
| `lastTieBreaker` |`id` with sort `createdAt`, `createdAt` with sort `id`|
| `queryTag` |HMAC from the canonical query set, including `limit`, with a separate domain prefix|
| `issuedAt` |server UTC time of the first page, unchanged until the end of the crawl|
| `expiresAt` |`issuedAt + 15 minutes`, unchanged until the end of the bypass|

Payload is serialized in canonical order, base64url encoded and receives HMAC-SHA256 via the key chosen by `kid` from `USER_LIST_CURSOR_HMAC_KEYS`. The resulting row has the format `payload.signature`. The signature is compared in constant time. For `queryTag` and the signature, the domain prefixes `users-list-query` and `users-list-cursor` are used.

Each subsequent page retains the original `issuedAt` and `expiresAt`, so fast queries do not extend the crawl indefinitely. Invalid base64url, unknown version or `kid`, invalid signature, future `issuedAt`, mismatched fifteen-minute interval, expired `expiresAt`, invalid field value and mismatched `queryTag` give the same **400 invalid_cursor** without details.

For `createdAt desc` the following page uses:

```text
(created_at, id) < (:lastCreatedAt, :lastId)
```

For `createdAt asc`, use `>`. For sort `id` the tuple order is changed to `(id, created_at)`. In both cases, `ORDER BY` lists the same fields and the same direction.

Cursor does not contain email, `displayName`, status, roles, JWT, signing key and SQL. It does not replace access: each request is again authenticated and `users@list`.

#### 1.3.3 Safe list element

|Field|Rule|
| --- | --- |
| `id: string` |immutable identifier|
| `email: string` |full normalized email, no masking|
| `displayName: string \| null` |saved NFC string or `null`|
| `photoUrl: string \| null` |secure HTTPS URL API; `null` without photo and with `deleting` or `deleted`|
| `status: string` |`pending`, `active`, `blocked`, `deleting` or `deleted`|
| `createdAt: string` | RFC 3339 UTC |
| `updatedAt: string` | RFC 3339 UTC |

The projector is fixed and does not depend on the role or search field. For `deleting`, the `photoUrl` field is equal to `null`; for `deleted` email is a random tombstone, and `displayName` and `photoUrl` are equal to `null`. For other statuses, the current allowed values are returned.

Email is not masked in any setting. A user without the right does not even receive a masked list, but a user with `users@list` receives the full field. items does not contain `password_hash`, challenge secrets, JWT, cookies, `photo_key`, roles, login timestamps, status reasons, deletion job and internal flags.

The `photoUrl` build does not access file storage. Retrieving the bytes themselves is a separate protected operation of viewing the photo and may require its own permissions.

#### 1.3.4 Races and changes between pages

`createdAt` and `id` are immutable, so the string already returned does not move relative to the cursor. The strict boundary `snapshotAt` excludes users created at the same time as the boundary was fixed or later, in both sorting directions; such rows will be included in the new crawl.

Changing `email`, `displayName`, or `status` does not change the sort position. If a row no longer matches a search or filter before the next page, it is not returned; if she started matching after passing her position, she will only appear in a new round. Cursor does not promise a historical MVCC snapshot between HTTP requests.

Deleting does not remove the main row: `deleting` and then `deleted` change the filter, but `id` and `createdAt` are retained. A client that needs a final set after a series of changes starts the first page without cursor.

### 1.4 Errors and limitations

- **400 Bad Request** - unknown or repeated query parameter; `limit` outside 1–100; invalid `searchBy`, `q`, `status`, `sort` or `order`; cursor is corrupted, expired, has an incorrect signature, `kid`, version or query tag.
- **401 Unauthorized** - access is missing, invalid, expired, or refers to a missing or inactive actor.
- **403 Forbidden** - active actor does not have current `users@list`.
- **429 Too Many Requests** - the list rate limit has been exceeded.
- **503 Service Unavailable** - the database, current RBAC snapshot or HMAC operation are unavailable; the database request exceeded 2 seconds; cursor key is not ready.

**404 Not Found** is not used for the list: a valid query with no matches returns **200** with an empty `items`. A single line error does not turn the page into a partial answer; if the dependency is unavailable, **503** is returned without items.

### 1.5 Audit/logs

Log:

- successful request with `actorUserId`, normalized names of the parameters involved, page size, `hasNext` attribute and duration;
- **401**, **403**, **400 invalid_cursor**, **429** and **503** in the safe category;
- exceeding the database timeout and using a plan that exceeds the monitoring threshold;
- readiness failure due to cursor key or RBAC.

The values `q`, cursor, email, `displayName`, `photoUrl`, composition `items` and the full URL are not logged. For search analytics, only `searchBy`, the presence of `status`, `sort`, `order`, `limit` and the irreversible short-lived request id are saved.

The log does not include PII lines, password, `password_hash`, challenge, JWT, `Cookie`, `Set-Cookie`, HMAC key, payload cursor, roles, full response body and full headers.

### 1.6 Non-functional requirements

- Endpoint allows no more than 60 actor requests per minute and 120 requests from IP per minute. The first limit exceeded receives **429**. A `limit` value greater than 100 is rejected rather than truncated.
- The database performs a keyset range on a composite index, selects `limit + 1` and does not calculate `totalCount`. Page building does not access photo storage.
- Cursor is valid for 15 minutes and is tied to the query of the first page. The search is parameterized: the symbols `%` and `_` do not receive a wildcard meaning.
- Automated tests cover a blank page, identical `createdAt`, both sorting directions, search and filter, cursor signature, TTL, query tag mismatch, and all five statuses in items.
- The general non-functional requirements of the project - input data validation, CORS, OpenAPI, structured logs, health checks and test coverage of at least 80% - also apply to this operation.


---

# 2.0 General File Transformation Requirements — Practical task

_Source: [2.0 General File Transformation Requirements.md](<2.0 General File Transformation Requirements.md#practical-task>)_

The functionality of the general file transformation process in the system.
The active user starts the supported transformation. The server calls the library through a common interface, returns the complete result, and stores safe metadata for the operation.

## 1) General requirements for file transformation

### 1.1 General

**Purpose:** to set a common interface, history and file life cycle rules for all transformations.

**Users/roles:** active user with permission `transformations`. The role name is not checked.

|Action|Operation|
| --- | --- |
| `convert` |`POST /api/convert`, `POST /api/images/convert` and both lists of directions|
| `history` |own history|
| `history_any` |history of the specified user; checked before searching for the target|
| `download` |downloading your own result|
| `download_any` |downloading the result of the specified user; checked before searching for the target|

During the first installation, while there is no `transformations` permission, the module creates these actions. The `user` role is assigned to `convert`, `history` and `download`. The role `admin`, if present, receives all actions. Restarting does not restore removed assignments. No role `user` - module readiness does not pass.

**Dependencies/related settings:**

- access JWT, cookies and authorization chain correspond to authentication and RBAC;
- specific pairs and limits are set by the requirements of text and images;
- one converter is registered for each direction;
- the temporary area is not publicly accessible;
- storage backend is specified by the application configuration.

The converter uses the library of the selected language. The practical contract is not to write a parser or codec yourself.

### 1.2 User stories

1. **Success:** the library converts the file, the server saves `success`, the client receives the result.
2. **Error:** server saves `error` and safe error code, temporary data is deleted.
3. **New pair:** a new implementation is registered without changing the contracts of already working pairs.
4. **History:** the user later receives the metadata of text and graphic operations in one list.
5. **Saving:** by explicit flag the challenge remains `success`, receives the key and `storageStatus=pending`; The HTTP response does not wait for object storage.
6. **Deleting a user: The** handler deletes its saved files and history.

### 1.3 Contract

#### 1.3.1 Converter interface

The converter receives:

- input stream;
- verified parameters;
- output stream.

It returns the actual `contentType`, extension and size, or a safe error code. It doesn't validate the JWT, generate an HTTP response, or write history.

#### 1.3.2 General procedure

1. Check access JWT and current status of `active`.
2. For a change request from another origin, check `Origin` and CSRF.
3. Check the `permission@action` pair of this operation. If refused, return **403** before parsing the file.
4. Check multipart, size and parameters of a specific operation.
5. Determine the original format and find the registered pair.
6. Call the library and generate a temporary result.
7. If successful, write down `success`, dimensions, duration and return the file.
8. If there is an error, write `error`, safe `errorCode` and return the status from section 1.4.
9. Delete temporary data for any outcome.

If the history write fails, no result is returned; temporary data is deleted and **503** is returned.

#### 1.3.3 History

Only the fields of table `transformations` are recorded in the history. Contents, parsed data, JWTs, cookies, temporary paths and library messages are not saved.

#### 1.3.4 Temporary data and storage

The original name is not used as a path. The temporary name is generated by the server.

Without saving, the result is deleted after the answer. With `save=true`, the server assigns the key and leaves a copy for background storage write according to the rules of `2.4`, without delaying the output of the converted file.

The user delete handler first deletes the user's owned objects, then the history rows. A missing object or row is considered to have already been deleted.

### 1.4 Errors and limitations

- **400 Bad Request** - a file or parameter is missing, the structure is damaged or the parameters are invalid.
- **401 Unauthorized** - the session is missing, invalid or the user is not `active`.
- **403 Forbidden** - no declared permission `transformations` or cross-origin CSRF check failed.
- **413 Content Too Large** - the input or result limit has been exceeded.
- **415 Unsupported Media Type** - The format or direction is not supported.
- **503 Service Unavailable** - The history database, temporary storage, or required dependency is unavailable.
- **504 Gateway Timeout** - the library did not complete its work within the specified time.

The library message and partial result are not returned to the client.

### 1.5 Audit/logs

Log: `requestId`, `transformationId`, `userId`, type, formats, sizes, result, secure `errorCode` and duration.

The log does not include the contents, parsed values, source name, temporary path, JWT, cookies, multipart body and stack trace of libraries.

### 1.6 Non-functional requirements

- Size and format-specific timeout limits apply. The result is returned only in its entirety.
- Calling a resource-intensive library does not block the reception of other requests: it is transferred to a separate thread or pool, but the HTTP response waits until the end of the conversion. The jobs queue is not used for the conversion itself.
- The history index covers `user_id, created_at, id`.
- Tests cover library selection, success, error, timeout, history, and temporary file cleanup.
- General non-functional project requirements and test coverage of at least 80% apply to all conversions.


---

# 2.1 Text Format Transformation — Practical task

_Source: [2.1 Text Format Transformation.md](<2.1 Text Format Transformation.md#practical-task>)_

Functionality for converting text files in the system.
The active user converts CSV, JSON, XML and YAML in any of twelve directions. Ready-made libraries perform parsing and serialization, and the server checks access, limits, errors and history.

## 1) Transformation of text formats

### 1.1 General

**Purpose:** convert a text file between CSV, JSON, XML and YAML.

**Users/roles:** active user with `transformations@convert`.

**Dependencies/related settings:**

- the general process and history are defined in `2.0`;
- the limit of each input format is set by the configuration, by default 10 MiB;
- maximum result - 50 MiB;
- timeout - 30 seconds;
- encoding is UTF-8, initial BOM is allowed.

### 1.2 User stories

1. **CSV → JSON/XML/YAML:** header and rows become a table of objects.
2. **JSON → CSV/XML/YAML:** library parses JSON and checks the form for target.
3. **XML → CSV/JSON/YAML:** secure XML parser generates the structure.
4. **YAML → CSV/JSON/XML:** safe loader forms the structure.
5. **List of directions:** the client receives four source formats and three targets for each.

### 1.3 Contract

#### 1.3.1 File conversion

| `POST /api/convert` |Checks/validation|
| --- | --- |
| `file: binary` |One non-empty `.csv`, `.json`, `.xml`, `.yaml` or `.yml`|
| `targetFormat: string` |`csv`, `json`, `xml` or `yaml`, different from source|
| `save: string` |Optional `true` or `false`, rules from `2.4`|
|Other fields|prohibited|

All twelve directions between different formats are supported.

**Logic/steps:**

1. Check access JWT and status `active`.
2. Check `transformations@convert`. If not available, return **403** before parsing the file.
3. Check multipart, extension, MIME and limit.
4. Parse the file with a library of the declared format.
5. Check that the structure is suitable for target.
6. Serialize the result with the target-format library.
7. Write `success` and return the file; If there is an error, write down `error`.

**Answers:**

- **200 OK:** file with correct `Content-Type` and `Content-Disposition: attachment; filename="converted.<ext>"`.
- **Errors:** see section 1.4.
- The response does not contain the original content, internal paths, JWTs, cookies or stack trace.

#### 1.3.2 Submission rules

- CSV has a required header; the values remain rows.
- CSV → JSON/YAML creates an array of objects.
- JSON/YAML → CSV accepts an array of flat objects with the same keys.
- CSV ↔ XML uses `rows`, `row`, `field name`.
- JSON ↔ YAML preserves data types, but not comments and formatting.
- XML ↔ JSON/YAML uses the `@attribute`, `#text`, array convention for repeating elements.

#### 1.3.3 List of destinations

| `GET /api/convert/formats` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC | `transformations@convert` |

**200 OK:**

```json
[
  {"source":"csv","target":["json","xml","yaml"]},
  {"source":"json","target":["csv","xml","yaml"]},
  {"source":"xml","target":["csv","json","yaml"]},
  {"source":"yaml","target":["csv","json","xml"]}
]
```

### 1.4 Errors and limitations

- **400 Bad Request** - the file is empty, the syntax or encoding is incorrect, the parameters are invalid, or the structure is not suitable for the target.
- **401 Unauthorized** - the session is missing, invalid or the user is not `active`.
- **403 Forbidden** - no `transformations@convert` or the CSRF check of the modifying request failed.
- **413 Content Too Large** - the input or result has exceeded the limit.
- **415 Unsupported Media Type** - source/target is not supported or the content does not match the extension.
- **503 Service Unavailable** - History or temporary storage is unavailable.
- **504 Gateway Timeout** - Processing did not complete within 30 seconds.

### 1.5 Audit/logs

Log: `userId`, `transformationId`, `sourceFormat`, `targetFormat`, dimensions, result, safe error code and duration.

Do not log content, parsed data, original name, temporary path, JWT, cookies and multipart body.

### 1.6 Non-functional requirements

- Use supported libraries rather than your own parsers. XML - without DTD and external entities, YAML - safe loader.
- Tests cover 12 directions, CSV quotes, Unicode, library errors, limits and timeout.
- General non-functional project requirements and test coverage of at least 80% are required.


---

# 2.2 Image Transformation — Practical task

_Source: [2.2 Image Transformation.md](<2.2 Image Transformation.md#practical-task>)_

Image conversion functionality in the system.
Active user converts PNG to JPEG, JPEG to PNG and SVG to PNG or JPEG. Ready-made graphics libraries perform decoding, rasterization and encoding, and the server sets safe parameters and limits.

## 1) Image transformation

### 1.1 General

**Purpose:** convert a supported image to PNG or JPEG.

**Users/roles:** active user with `transformations@convert`.

**Dependencies/related settings:**

- the general process and history are set in `2.0`;
- the input limit is set separately for PNG, JPEG and SVG, by default 10 MiB;
- the maximum side of the result is 4096, the maximum is 16,777,216 pixels;
- JPEG quality default 85;
- default background `#ffffff`;
- timeout - 30 seconds.

### 1.2 User stories

1. **PNG → JPEG:** library mixes alpha with background and encodes JPEG.
2. **JPEG → PNG:** library decodes JPEG and encodes PNG.
3. **SVG → PNG:** safe SVG is rasterized to PNG.
4. **SVG → JPEG:** SVG is rasterized and given a background.
5. **List of directions:** the client receives only four pairs.

PNG/JPEG → SVG and format conversion to itself are not supported.

### 1.3 Contract

#### 1.3.1 Image conversion

| `POST /api/images/convert` |Checks/validation|
| --- | --- |
| `file: binary` |One non-blank PNG, JPEG or SVG|
| `targetFormat: string` |`png` or `jpeg`|
| `options: string` |Optional JSON object|
| `save: string` |Optional `true` or `false`, rules from `2.4`|
|Other fields|prohibited|

`png→jpeg`, `jpeg→png`, `svg→png`, `svg→jpeg` are supported.

**Logic/steps:**

1. Check access JWT and status `active`.
2. Check `transformations@convert`. If not available, return **403** before parsing the file.
3. Check multipart, extension, MIME and limit.
4. Check direction and `options`.
5. Pass the file and parameters to the selected library.
6. Check the final dimensions and generate a temporary result.
7. Write `success` and return the file; If there is an error, write down `error`.

**Answers:**

- **200 OK:** `image/png` or `image/jpeg`, `Content-Disposition: attachment; filename="converted.<ext>"`, `X-Content-Type-Options: nosniff`.
- **Errors:** see section 1.4.
- The response does not include the original name, SVG text, EXIF, internal paths, JWTs, or cookies.

#### 1.3.2 Parameters

|Field|Rule|
| --- | --- |
| `quality` |Integer 1–100, JPEG only, default 85|
| `width` |Integer 1–4096, SVG only|
| `height` |Integer 1–4096, SVG only|
| `background` |`#RRGGBB`, JPEG only, default `#ffffff`|

If no dimensions are provided for an SVG, its intrinsic dimensions are used; if those are unavailable, the default is 1024×1024. Providing one dimension preserves the aspect ratio. Unknown or inapplicable fields return **400**.

#### 1.3.3 SVG Security

SVG is parsed without DTD, external entities and network. `script`, `foreignObject`, event handlers and external resources are prohibited.

The result is always a PNG or JPEG; the original SVG is not directly returned.

#### 1.3.4 List of destinations

| `GET /api/images/convert/formats` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC | `transformations@convert` |

**200 OK:**

```json
[
  {"source":"png","target":["jpeg"]},
  {"source":"jpeg","target":["png"]},
  {"source":"svg","target":["png","jpeg"]}
]
```

### 1.4 Errors and limitations

- **400 Bad Request** - the file is damaged, options are invalid, SVG is unsafe or dimensions are invalid.
- **401 Unauthorized** - the session is missing, invalid or the user is not `active`.
- **403 Forbidden** - no `transformations@convert` or the CSRF check of the modifying request failed.
- **413 Content Too Large** - the input or result has exceeded the limit.
- **415 Unsupported Media Type** - format or direction is not supported.
- **503 Service Unavailable** - History, time area or library is unavailable.
- **504 Gateway Timeout** - Processing did not complete within 30 seconds.

### 1.5 Audit/logs

Log: `userId`, `transformationId`, formats, input and result size, final sizes, result, safe error code and duration.

Do not log bytes, SVG/XML, EXIF, source name, temporary path, JWT, cookies and multipart body.

### 1.6 Non-functional requirements

- Use supported libraries rather than proprietary codecs. SVG renderer does not have network access. The result is re-encoded without the original metadata.
- The tests cover four pairs, alpha, EXIF, sizes, dangerous SVG, limits and timeout.
- General non-functional project requirements and test coverage of at least 80% are required.


---

# 2.3 Viewing User File Transformation History — Practical task

_Source: [2.3 Viewing User File Transformation History.md](<2.3 Viewing User File Transformation History.md#practical-task>)_

Functionality for viewing the history of user transformations in the system.
The active user receives pages of his own history, and the holder of administrative permission receives the history of the specified user. The response contains metadata without file content and PII.

## 1) View transformation history

### 1.1 General

**Purpose:** to return a page of completed text and graphic transformations.

**Users/roles:**

- Self with `transformations@history` - own history after authentication;
- Admin with `transformations@history_any` - history of the specified user.

**Dependencies/related settings:**

- table `transformations` is defined in `2.0`;
- default page size is 20, maximum 100;
- sorting is always `created_at DESC, id DESC`;
- The default storage period is 90 days.

### 1.2 User stories

1. **Self:** the user receives a page of his own operations.
2. **Continued:** `nextCursor` opens the next page.
3. **Admin:** After checking the right, the target history is returned.
4. **Filters:** type, formats, status and period limit the list.
5. **Empty page:** A valid query without results returns an empty array.

### 1.3 Contract

#### 1.3.1 Query parameters

|Parameter|Rule|
| --- | --- |
| `cursor: string` |optional next page position|
| `limit: integer` |1–100, default 20|
| `type: string` |`file` or `image`|
| `sourceFormat: string` |supported source format|
| `targetFormat: string` |supported target format|
| `status: string` |`success` or `error`|
| `createdAtFrom: date-time` |inclusive UTC boundary|
| `createdAtTo: date-time` |exclusive UTC boundary|

All filters are optional. If there is a cursor `limit` and all filters must match the canonical set inside the cursor. The other set receives **400** and requires a new first page.

#### 1.3.2 Own history

| `GET /api/transformations/history` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC | `transformations@history` |

**Logic/steps:**

1. Check access and query.
2. Check `transformations@history`. If not available, return **403** before reading the history.
3. Take `userId` from `sub`.
4. Apply filters and condition after cursor.
5. Select `limit + 1` rows in a fixed order.
6. Return no more than `limit`; if there is a continuation, form `nextCursor` with the same set of filters.

#### 1.3.3 History of the specified user

| `GET /admin/users/{userId}/transformations/history` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC | `transformations@history_any` |

Eligibility is checked before the target is found. After admission, the absent user receives **404**. The rest of the filters and pagination are the same as Self.

#### 1.3.4 Response form

**200 OK:**

- `items: TransformationHistoryItem[]`;
- `nextCursor: string | null`.

`TransformationHistoryItem` contains:

- `id`;
- `type`;
- `sourceFormat`;
- `targetFormat`;
- `status`;
- `inputSize`;
- `outputSize: number | null`;
- `durationMs: number`;
- `errorCode: string | null`;
- `createdAt`;
- `storageStatus: "not_requested" | "pending" | "available" | "error"`;
- `hasStoredFile`;
- `fileExpiresAt: date-time | null`.

Before saving from `2.4` is implemented, all entries return `storageStatus=not_requested`, `hasStoredFile=false`, and `fileExpiresAt=null`. Storage fields appear in the schema along with `2.4`.

The response does not contain `userId`, email, file name, content, temporary path or storage key.

#### 1.3.5 Cursor and retention

Cursor encodes the version, `createdAt`, `id` of the last entry and the canonical set `limit`, `type`, `sourceFormat`, `targetFormat`, `status`, `createdAtFrom`, `createdAtTo` via base64url. The missing filter is explicitly coded. After decoding, the version, time format, identifier, and the match of the set with the current query are checked. An invalid cursor and a set mismatch results in **400**.

Cleanup deletes records older than the configured period. If there is a saved object, its deletion is called first; the absence of an object is considered a cleanup that has already been completed.

### 1.4 Errors and limitations

- **400 Bad Request** - query, period or cursor is invalid.
- **401 Unauthorized** - the session is missing, invalid or the user is not `active`.
- **403 Forbidden** - own history is called without `transformations@history` or admin path is called without `transformations@history_any`.
- **404 Not Found** - the target user admin path was not found after checking permissions.
- **429 Too Many Requests** - the history reading rate limit has been exceeded.
- **503 Service Unavailable** - database or RBAC unavailable.

### 1.5 Audit/logs

Log: `actorUserId`, Self/Admin, `targetUserId` for an allowed admin request, filter category, limit, number of elements, result and duration.

Do not log the full cursor, file contents, email, file names, storage key, JWT, cookies and the full response.

### 1.6 Non-functional requirements

- Pagination is required, offset is not used. The index covers `user_id, created_at, id`. The request selects only the response and `limit + 1` fields.
- History reading allows no more than 60 user requests per minute; the next one gets **429**.
- Retention deletes records older than the configured period in small portions. If an object is present, its deletion is called first.
- The tests cover Self/Admin, identical `createdAt`, cursor, filters, blank page and retention.
- General non-functional project requirements and test coverage of at least 80% are required.


---

# 2.4 Saving Transformation Results to Storage — Practical task

_Source: [2.4 Saving Transformation Results to Storage.md](<2.4 Saving Transformation Results to Storage.md#practical-task>)_

Functionality for saving the results of transformations in the system.
The user explicitly chooses to save the result in the background. The converted file is returned immediately and the save status is shown in the history. The saved object remains private, downloaded only via the API and deleted after retention.

## 1) Saving transformation results

### 1.1 General

**Purpose:** to save a successful result and provide a secure download.

**Users/roles:**

- Self with `transformations@convert` saves the result and with `transformations@download` downloads only its own;
- Admin from `transformations@download_any` downloads the result of the specified user.

**Dependencies/related settings:**

- transformations and history are defined in `2.0`–`2.3`;
- `save` default `false`;
- storage backend is specified by configuration;
- only the successful result, already limited by the conversion limit, is saved;
- Default retention is 90 days.

### 1.2 User stories

1. **Without saving:** the result is returned and deleted after the response.
2. **With saving:** the result is returned immediately, the history receives `pending`, and the background task writes the object.
3. **Self download:** the owner receives the saved file.
4. **Admin download:** after the right the file of the specified user is returned.
5. **Expiration:** object is deleted, download returns **404**.
6. **Storage failure:** The transformation remains successful, and the history gets `storageStatus=error`.

### 1.3 Contract

#### 1.3.1 Save flag

|Operations|Additional multipart field|
| --- | --- |
| `POST /api/convert` |`save: string`, optional, `true` or `false`|
| `POST /api/images/convert` |same|

The missing `save` is equal to `false`. The remaining values receive **400**.

**Logic at `save=false`:**

1. Perform a normal transformation.
2. Write `success` without storage key.
3. Return the result and clear the temporary file.

**Logic at `save=true`:**

1. Perform a normal transformation.
2. Generate a random `stored_file_key` and store a copy of the result in the internal temporary area under this key.
3. Write down `success`, `storage_status=pending` and key.
4. Return the file without waiting for object storage.
5. The background task reads rows from `storage_status=pending`, writes an object using an already known key, and puts `available` with `stored_file_until`.

If it was not possible to create a copy for saving, the file is still returned, and the history receives `storage_status=error`. If storage is temporarily unavailable, the row remains `pending`, and the task retries the write using the same key. A permanent failure or disappearance of the temporary copy transfers the save to `error`. Repeated entry using the same key does not create a second object.

A successful response contains `X-Transformation-Id` and `X-Save-Status: not_requested|pending|error`. The final state is read from history. A separate task table is not needed: the queue is history rows with the status `pending`.

#### 1.3.2 Own download

| `GET /api/transformations/history/{itemId}/download` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC |`transformations@download` before searching for a record|

The absence of `transformations@download` gives **403** before searching. After admission, the entry is selected by `itemId` and the current `userId`. A foreign, missing, unsaved, erroneous or expired result receives **404**. The status `pending` gets **409 Conflict** with code `file_not_ready`.

If successful, the server reads the object stream and returns **200**, contract `Content-Type`, `Content-Disposition: attachment; filename="converted.<ext>"` and `X-Content-Type-Options: nosniff`.

If the history contains a key, but storage does not find the object, **503** is returned and a mismatch event is generated.

#### 1.3.3 Administrative download

| `GET /admin/users/{userId}/transformations/history/{itemId}/download` |Checks|
| --- | --- |
| Cookie `access_token` |current user `active`|
| RBAC | `transformations@download_any` |

The right is checked before the user is found. After admission, the missing user or item receives **404**. The rest of the rules are the same as Self.

#### 1.3.4 History expansion

The history item gets:

- `storageStatus: "not_requested" | "pending" | "available" | "error"`;
- `hasStoredFile: boolean`;
- `fileExpiresAt: date-time | null`.

`hasStoredFile=true` only with `available`. Storage key, local path, bucket and internal error code are not included in the response.

#### 1.3.5 Retention and user deletion

The background task selects expired records in small portions. For a stored result, it first calls `delete(key)`, then clears the storage fields. `not_found` is considered a successful deletion. The user deletion handler performs the same actions immediately for all of the user's records.

### 1.4 Errors and limitations

- **400 Bad Request** - `save` is not `true` or `false`.
- **401 Unauthorized** - the session is missing, invalid or the user is not `active`.
- **403 Forbidden** - your download was called without `transformations@download`, admin download was called without `transformations@download_any`, or the CSRF POST check failed.
- **404 Not Found** - the user, item or saved file is not available after checking permissions.
- **409 Conflict** - the save still has the state `pending`.
- **503 Service Unavailable** - the database is unavailable during the download operation or the history indicates a missing object.

Unavailability of persistent storage does not affect `save=false` and does not delay a successful response with `save=true`; the error becomes visible in history.

### 1.5 Audit/logs

Log: `userId`, `transformationId`, action `save`, `download` or `delete`, size, result and duration.

Do not log content, original name, storage key, path, bucket, credentials, JWT, cookies and full storage response.

### 1.6 Non-functional requirements

- Storage adapter supports `save`, `read`, `delete`. The files are private and are not available via a direct public link.
- The background record reads `storage_status=pending` and writes the object using a previously saved key. Cleanup and eraser consider `not_found` a success.
- The index covers `storage_status` and `stored_file_until`.
- The tests cover `save=false/true`, `pending/available/error` transitions, repeated writes using the same key, Self/Admin download, IDOR and expiration.
- General non-functional project requirements and test coverage of at least 80% are required.
