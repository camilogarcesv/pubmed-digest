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
export async function snapshot(sql: Sql, tables: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of tables.filter(t => !['operation_lock', 'operation_assertions'].includes(t))) {
    const rows = await sql(`SELECT * FROM ${table}`);
    const encoded = rows.map(row => JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]))).sort();
    result[table] = createHash('sha256').update(JSON.stringify(encoded)).digest('hex');
  }
  return result;
}
export function assertPreserved(before: Record<string, string>, after: Record<string, string>): void {
  if (Object.entries(before).some(([key, value]) => after[key] !== value)) throw new Error('Database content changed');
}
