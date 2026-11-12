# Config Module

Type-safe configuration over `@nestjs/config`. `validate()` in `config.validation.ts` is the **only** way config enters the app. It runs the Joi schema, then the cross-field rules, and fails fast at startup.

## Usage

```typescript
constructor(private readonly config: ConfigService) {}

this.config.get('PORT');          // number
this.config.get('CORS_ORIGINS');  // string[]
```

## Rules

- **Secrets** (`SECRET_KEY_NAMES` and every key in `USER_LIST_CURSOR_HMAC_KEYS`) are base64url and decode to at least 32 bytes. A key made of one repeated byte is rejected. **All secrets must be different**, which `assertDistinctKeys()` checks by decoded bytes. Generate them with `npm run keys:generate`; the app never generates keys itself.
- **Durations** use the `duration(min, max)` helper. A value without a unit is rejected (`ms('15')` would mean 15 ms).
- **Production** requires `COOKIE_SECURE=true` and an https `PUBLIC_API_BASE_URL`.
- Error messages name variables, never values.

## Adding an option

1. Add it to `AppConfig` in `config.types.ts`.
2. Add it to `configSchema` in `config.validation.ts`. If it's a secret, also add it to `SECRET_KEY_NAMES` and `scripts/generate-keys.mjs`.
3. Add it to `.env.example`, `.env.test` and, if CI needs a non-default value, `.github/workflows/ci.yml`.
4. Cover it in `config.validation.spec.ts`.
