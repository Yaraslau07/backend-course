/**
 * One home for the D51 id rules shared by the user features: a path id of 1–128 safe characters
 * that isn't a UUID is an absent target (bound as `null`, never cast), and UUID case never changes
 * who a user is.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidOrNull = (id: string): string | null =>
  id.length === 36 && UUID.test(id) ? id : null;

export const sameUserId = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();
