import type { PermissionSeed } from '@/modules/rbac/permission-seeds';

/** Spec 2.0 §1.1: the permission, its actions, and what the `user` role gets on first install. */
export const TRANSFORMATIONS_SEED: PermissionSeed = {
  permission: 'transformations',
  actions: ['convert', 'history', 'history_any', 'download', 'download_any'],
  defaultRoleActions: ['convert', 'history', 'download'],
};

/** The module's own readiness (spec 2.0 §1.1): no `user` role, or no permission yet, is not ready. */
export const ACCESS_READY_SQL = `
  SELECT EXISTS (SELECT 1 FROM roles WHERE name = 'user')
     AND EXISTS (SELECT 1 FROM permissions WHERE name = 'transformations') AS ready`;
