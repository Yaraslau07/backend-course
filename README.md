# Backend Course

NestJS monolith for the backend course: registration, cookie-based JWT auth, RBAC, user management and file transformations. Everything is driven through an HTTP client; there is no frontend.

**HTTP kernel is Fastify** (`@nestjs/platform-fastify`), not Express.

## Quick start

```bash
nvm use                                  # Node 22
npm install
docker compose up -d                     # Postgres (app + app_test) and Mailpit
cp .env.example .env
npm run keys:generate                    # paste the output over the empty key lines in .env
npm run start:dev
curl http://localhost:3007/health/live   # {"status":"ok"}
```

API docs (development only): http://localhost:3007/docs. Caught emails: http://localhost:8025.

## Scripts

| Script | What it does |
|---|---|
| `start:dev` / `start:prod` | watch mode / `node dist/main` |
| `build`, `typecheck`, `lint`, `format` | the usual |
| `test`, `test:cov` | unit tests; `test:cov` enforces 80% coverage |
| `test:e2e` | e2e against the `app_test` DB using `.env.test` |
| `keys:generate` | prints fresh secret keys (32 random bytes, base64url each) |
| `migration:generate`, `migration:run`, `migration:revert`, `migration:show` | TypeORM CLI via `src/database/data-source.ts` |

## Configuration

All variables are validated at startup by `src/core/config/config.validation.ts`. The app refuses to boot on a missing or invalid value. See `.env.example` for the full list and `src/core/config/README.MD` for the rules. Every secret must be at least 32 random bytes and different from every other secret.

## Health

| Route | Access | Meaning |
|---|---|---|
| `GET /health/live` | public | process is up (used by the Docker `HEALTHCHECK`) |
| `GET /health/ready` | `READINESS_ALLOWED_IPS` only (404 otherwise) | every registered check (DB, keys, …) is up; 503 if not |

## Project structure

```
src/
├── core/
│   ├── app/        # root module + configureApp() shared with e2e tests
│   ├── config/     # validated, typed config
│   ├── database/   # TypeORM module (explicit transactions)
│   ├── health/     # liveness, readiness + ReadinessRegistry
│   └── logging/    # nestjs-pino, request ids, log pseudonyms
├── database/       # shared connection options, CLI data source, migrations
├── modules/        # feature modules
└── main.ts
docs/
├── specs/          # the assignment, one file per lesson
├── invariants.md   # cross-cutting rules
├── decisions.md    # why things are the way they are
└── known-gaps.md   # what's deliberately not done yet
```

## Docker

```bash
docker build -t backend-course .
```

The image runs `node dist/main.js` under `tini` as user `node` with `NODE_ENV=production`. Pass every variable from `.env.example`; production requires `COOKIE_SECURE=true` and an https `PUBLIC_API_BASE_URL`.

## CI

`.github/workflows/ci.yml` runs:
- lint and typecheck
- unit tests with the coverage gate
- e2e against Postgres, after migrations
- Docker build plus a smoke test that hard-checks liveness and readiness
- `npm audit`
- Trivy
- the PR title check
