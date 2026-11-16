/**
 * The format of role names, permission names and actions (spec 1.1), applied after trim + lowercase.
 * Kept as a string because both the CHECK constraints and the request validation are built from it.
 */
export const RBAC_NAME_PATTERN = '^[a-z][a-z0-9._-]{0,63}$';
