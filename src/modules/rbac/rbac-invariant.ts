import type { EntityManager } from 'typeorm';
import { AppException } from '@/core/errors/app.exception';

export const HOLDER_REMAINS = `
  SELECT EXISTS (
    SELECT 1
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN grants g ON g.role_id = ur.role_id
      JOIN permissions p ON p.id = g.permission_id AND p.name = $1
      JOIN permission_actions pa ON pa.permission_id = p.id AND pa.action = $2
     WHERE u.status = 'active'
       AND (g.all_actions OR EXISTS (
             SELECT 1 FROM grant_actions ga WHERE ga.grant_id = g.id AND ga.action = $2))
  ) AS ok`;

export async function lockRbacPolicy(manager: EntityManager): Promise<void> {
  await manager.query(
    'SELECT id FROM rbac_policy_state WHERE id = 1 FOR UPDATE',
  );
}
export async function assertRbacManagerRemains(
  manager: EntityManager,
): Promise<void> {
  const [{ ok }] = await manager.query<{ ok: boolean }[]>(HOLDER_REMAINS, [
    'rbac',
    'manage',
  ]);
  if (!ok) throw new AppException('last_rbac_manager');
}
