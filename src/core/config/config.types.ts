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
  /** `none` only for a frontend on another site (spec 1.2 §1.3.3); needs COOKIE_SECURE. */
  COOKIE_SAME_SITE: 'strict' | 'none';
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

  /* Rate-limit counter keys are HMACs of IPs, emails and user ids, never the values */
  RATE_LIMIT_KEY_HMAC_KEY: string;

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

  /** Private temporary area for conversions (spec 2.0 §1.3.4); empty means `<os tmpdir>/backend-course-transformations`. */
  TRANSFORMATION_TEMP_DIR: string;
  /** Worker threads for converters (spec 2.0 §1.6). */
  TRANSFORMATION_WORKER_THREADS: number;
  /** Spec 2.3 §1.1: history rows older than this are deleted (default 90 days). */
  TRANSFORMATION_HISTORY_RETENTION_DAYS: number;
  /** Spec 2.1 §1.1: input limit per text format (default 10 MiB each). */
  TEXT_CSV_MAX_BYTES: number;
  TEXT_JSON_MAX_BYTES: number;
  TEXT_XML_MAX_BYTES: number;
  TEXT_YAML_MAX_BYTES: number;
  /** Spec 2.1 §1.1: 30 seconds. */
  TEXT_CONVERSION_TIMEOUT_MS: number;
  /** Spec 2.2 §1.1: input limit per image format (default 10 MiB each), and the timeout. */
  IMAGE_PNG_MAX_BYTES: number;
  IMAGE_JPEG_MAX_BYTES: number;
  IMAGE_SVG_MAX_BYTES: number;
  IMAGE_CONVERSION_TIMEOUT_MS: number;

  /** Single-instance development/test storage; production uses S3. */
  STORAGE_LOCAL_ROOT: string;
  STORAGE_DRIVER: 'local' | 's3';
  STORAGE_WORKERS_ENABLED: boolean;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_PREFIX: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;

  /* SMTP */
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM: string;
}
