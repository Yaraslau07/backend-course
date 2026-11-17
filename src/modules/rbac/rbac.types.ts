/**
 * The format of role names, permission names and actions (spec 1.1), applied after trim + lowercase.
 * Kept as a string because both the CHECK constraints and the request validation are built from it.
 */
export const RBAC_NAME_PATTERN = '^[a-z][a-z0-9._-]{0,63}$';

/** The role every user gets on activation (spec 1.0, 1.1) and the bootstrap's admin role. */
export const DEFAULT_ROLE = 'user';
export const ADMIN_ROLE = 'admin';

/** The pair whose holders must never drop to zero (spec 1.1 §1.1). */
export const RBAC_MANAGE = { permission: 'rbac', action: 'manage' } as const;
