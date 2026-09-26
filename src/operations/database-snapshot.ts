import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { migrations } from './release-checks.js';

type Row = Record<string, unknown>;
export type Sql = (query: string) => Promise<Row[]>;
const normalize = (s: unknown) => String(s).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/** Compare every table, index and trigger against the tracked migrations. */
export async function assertSchema(sql: Sql, applied: string[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const expected = new DatabaseSync(':memory:');
  try {
    for (const name of applied) {
      if (!migrations.includes(name)) throw new Error('Unknown migration');
      expected.exec(await readFile(`worker/migrations/${name}`, 'utf8'));
    }
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' ORDER BY name";
    const canonical = (rows: Row[]) => JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, normalize(row.sql)]));
    if (canonical(await sql(query)) !== canonical(expected.prepare(query).all())) throw new Error('Schema mismatch');
  } finally { expected.close(); }
}

/** Stable content digest, independent of provider row/object ordering. */
export type Snapshot = Record<string, { columns: string[]; hash: string }>;
export async function snapshot(sql: Sql, tables: string[], baseline?: Snapshot): Promise<Snapshot> {
  const result: Snapshot = {};
  // Leases and in-flight legacy vote claims are transient; a vote may come and go during a legacy release.
  for (const table of tables.filter(t => !['operation_lock', 'operation_assertions', 'legacy_vote_inflight'].includes(t))) {
    const columns = baseline?.[table]?.columns ?? (await sql(`PRAGMA table_info(${table})`)).map(row => String(row.name)).sort();
    // Column names come from a schema already checked against tracked migrations.
    // New nullable/defaulted columns do not change the digest of pre-existing fields.
    const rows = await sql(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM ${table}`);
    const encoded = rows.map(row => JSON.stringify(columns.map(key => [key, row[key]]))).sort();
    result[table] = { columns, hash: createHash('sha256').update(JSON.stringify(encoded)).digest('hex') };
  }
  return result;
}
export function assertPreserved(before: Snapshot, after: Snapshot): void {
  if (Object.entries(before).some(([key, value]) => after[key]?.hash !== value.hash)) throw new Error('Database content changed');
}
