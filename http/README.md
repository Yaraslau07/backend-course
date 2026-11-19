# HTTP requests

Runnable request files for the WebStorm/IntelliJ HTTP Client (also readable as plain documentation). They are the manual smoke test for each checkpoint, run against `npm run start:dev`.

- Pick the `dev` environment (`http-client.env.json`).
- One file per area: `health.http`, `errors.http`, `auth.http`, `rbac.http`, `users.http`, `users-update.http`, `users-delete.http`, `convert.http`, `images.http`, `history.http`, `storage.http`.
- Never put a real password, token or key in these files. Test accounts use `@example.com` addresses and throwaway passwords.
