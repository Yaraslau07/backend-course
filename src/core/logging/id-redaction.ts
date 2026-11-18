/**
 * Spec 1.6 §1.5: deletion logs carry no `actorUserId`, `targetUserId` or job id. The shared
 * authorization steps log ids for every other route, so they ask here by operation name
 * (`<Controller>.<handler>` from the guard, `<Service>.<step>` from handlers).
 */
const NO_ID_PREFIXES = ['UsersDeletionController.', 'UsersDeletion.'];

export function logsIds(operation: string | undefined): boolean {
  return (
    operation === undefined ||
    !NO_ID_PREFIXES.some((prefix) => operation.startsWith(prefix))
  );
}
