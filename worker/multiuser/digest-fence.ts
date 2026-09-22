import { DomainError } from '../../src/multiuser/contracts.js';

/** Digest writes happen only while D1 is the operating mode; every write transaction re-checks it. */
export const D1_MODE = "(SELECT mode FROM system_controls WHERE singleton=1)='d1'";
export const ACTIVE_USER = "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')";

/** A false or NULL condition violates digest_assertions and aborts the whole batch. */
export function guard(db: D1Database, condition: string, args: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO digest_assertions(valid) VALUES((${condition}))`).bind(...args);
}
export function clear(db: D1Database): D1PreparedStatement {
  return db.prepare('DELETE FROM digest_assertions');
}

/** A precondition that no longer holds is a conflict for the caller, not an internal error. */
export async function fenced(db: D1Database, statements: D1PreparedStatement[], message: string): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (/digest_precondition|digest_assertions\.valid/.test(String(error))) throw new DomainError('conflict', message);
    throw error;
  }
}
