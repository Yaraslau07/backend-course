export type DbErrorClass =
  | { kind: 'unique_violation'; constraint?: string }
  | { kind: 'unavailable'; dbCode: string }
  | { kind: 'other'; dbCode: string };

/**
 * SQLSTATE classes and codes that mean "the database can't answer right now", not "the request
 * is wrong": connection exceptions (08), insufficient resources (53), shutdown or startup (57P0x),
 * a statement timeout or cancel (57014, the 2 s list timeout in spec 1.7), and a serialization
 * failure or deadlock (40001, 40P01), where the transaction was rolled back and a retry may succeed.
 */
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0)|^(57014|40001|40P01)$/;

/** Socket errors from the pg driver when Postgres is unreachable. */
const UNAVAILABLE_SOCKET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
]);

/** pg and pg-pool raise these without a code. Exact messages, so nothing else matches by accident. */
const UNAVAILABLE_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
]);

/** TypeORM's own "no connection" errors. */
const NOT_CONNECTED_NAMES = new Set([
  'CannotExecuteNotConnectedError',
  'ConnectionIsNotSetError',
]);

function stringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
}

/**
 * Sorts a thrown value into "unique violation", "database unavailable", "other database error",
 * or null for anything that isn't a database error. Reads only codes and names, never messages
 * that could contain values (except the fixed pg-pool messages above).
 */
export function classifyDbError(error: unknown): DbErrorClass | null {
  if (!(error instanceof Error)) return null;

  if (NOT_CONNECTED_NAMES.has(error.name)) {
    return { kind: 'unavailable', dbCode: 'not_connected' };
  }

  // A QueryFailedError carries the pg error as `driverError`; a raw pg error carries the fields itself.
  const source =
    error.name === 'QueryFailedError'
      ? ((error as Error & { driverError?: unknown }).driverError ?? error)
      : error;
  const code = stringProp(source, 'code');

  if (code !== undefined && UNAVAILABLE_SOCKET.has(code)) {
    return { kind: 'unavailable', dbCode: code };
  }
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code)) {
    if (code === '23505') {
      return {
        kind: 'unique_violation',
        constraint: stringProp(source, 'constraint'),
      };
    }
    if (UNAVAILABLE_SQLSTATE.test(code)) {
      return { kind: 'unavailable', dbCode: code };
    }
    return { kind: 'other', dbCode: code };
  }
  if (UNAVAILABLE_MESSAGES.has(error.message)) {
    return { kind: 'unavailable', dbCode: 'connection' };
  }
  return null;
}
