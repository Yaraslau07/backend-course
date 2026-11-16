export type NodeEnv = 'development' | 'test' | 'production';
export type ConfirmationMethod = 'otp' | 'magic_link';

export interface CursorKey {
  kid: string;
  /** base64url-encoded key material (>= 32 decoded bytes) */
  key: string;
}

/**
 * The validated, transformed application config.
 * Produced once by `validate()` in `config.validation.ts`; the app never reads `process.env` directly.
 */
export interface AppConfig {
  /* Server */
  NODE_ENV: NodeEnv;
  PORT: number;
  TRUST_PROXY: boolean;
  PUBLIC_API_BASE_URL: string;
  FRONTEND_URL: string;
  CORS_ORIGINS: string[];
  COOKIE_SECURE: boolean;
  READINESS_ALLOWED_IPS: string[];

  /* PostgreSQL */
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_LOGGING: boolean;
  POSTGRES_MIGRATIONS_RUN: boolean;

  /* JWT */
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;

  /* Email challenge HMAC keys (one per scenario, never shared) */
  REGISTRATION_CHALLENGE_HMAC_KEY: string;
  LOGIN_CHALLENGE_HMAC_KEY: string;
  EMAIL_CHANGE_HMAC_KEY: string;
  DELETION_CHALLENGE_HMAC_KEY: string;

  /* Admin user list cursor key ring */
  USER_LIST_CURSOR_ACTIVE_KEY_ID: string;
  USER_LIST_CURSOR_HMAC_KEYS: CursorKey[];

  /* Irreversible pseudonyms in logs (e.g. unknown email on login) */
  LOG_PSEUDONYM_HMAC_KEY: string;

  /* Flow flags */
  REGISTRATION_EMAIL_CONFIRMATION_ENABLED: boolean;
  REGISTRATION_EMAIL_CONFIRMATION_METHOD: ConfirmationMethod;
  LOGIN_EMAIL_CONFIRMATION_ENABLED: boolean;
  LOGIN_EMAIL_CONFIRMATION_METHOD: ConfirmationMethod;
  EMAIL_CHANGE_METHOD: ConfirmationMethod;
  DELETION_CONFIRMATION_METHOD: ConfirmationMethod;
  REGISTRATION_RATE_LIMIT_PER_HOUR: number;
  RBAC_BOOTSTRAP_ADMIN_USER_ID?: string;
  DELETION_WORKER_LEASE_SECONDS: number;

  /* SMTP */
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM: string;
}
