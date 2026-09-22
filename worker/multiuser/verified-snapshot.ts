import { z } from 'zod';

/** A bound SELECT and the exact JSON bytes validated by the caller, replayed by its write guard. */
export type VerifiedSnapshot = { sql: string; userId: string; raw: string };
export async function snapshotRows<T>(db: D1Database, select: string, columns: string[], key: string, snapshots?: VerifiedSnapshot[]): Promise<T[]> {
  // SQL and column names are internal constants. All external identifiers are bound.
  const sql = `SELECT json_group_array(json_object(${columns.map(c => `'${c}',${c}`).join(',')})) FROM (${select})`;
  const raw = z.string().parse((await db.prepare(`SELECT (${sql}) AS data`).bind(key).first<{ data: string }>())?.data);
  snapshots?.push({ sql, userId: key, raw });
  return JSON.parse(raw) as T[];
}
