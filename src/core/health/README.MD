# Health Module

| Route | Who can call it | Behaviour |
|---|---|---|
| `GET /health/live` | anyone (public) | `200 {status:'ok'}`. Touches no dependency, so a DB outage never restarts the container. The Docker `HEALTHCHECK` uses it. |
| `GET /health/ready` | IPs in `READINESS_ALLOWED_IPS` (default loopback); everyone else gets `404` | Runs every registered check in parallel (1 s timeout each). Returns `200 {status:'ok', checks}` or `503 {status:'unavailable', checks}`. Reasons are logged, never returned. |

## Registering a check

`HealthModule` is global. Inject `ReadinessRegistry` and register in `onModuleInit`:

```typescript
onModuleInit() {
  this.readiness.register('rbac_snapshot', async () =>
    this.snapshot.isLoaded() ? 'up' : { down: 'not_loaded' },
  );
}
```

Built in: `database` (`SELECT 1`) and `config` (all keys decode, active cursor kid exists). Registering no checks at all counts as not ready.

Planned registrations: RBAC snapshot, route declarations, erasers for every module that stores user data, SMTP, the storage backend.
