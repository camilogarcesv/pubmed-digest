import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps every trigger CASE parenthesized for the remote D1 statement parser', async () => {
  const sql = (await readFile('worker/migrations/0002_draft_guards.sql', 'utf8')).replace(/--[^\n]*/g, '');
  // Local SQLite accepts the broken form too: this is a syntax regression guard,
  // not a simulation of D1's remote parser. Behavioral guards run in workerd.
  expect(sql.match(/\bCASE\b/g)).toHaveLength(3);
  expect(sql.match(/SELECT\s+\(CASE\b/g)).toHaveLength(3);
  expect(sql.match(/\bEND\);/g)).toHaveLength(3);
  expect(sql).not.toMatch(/SELECT\s+CASE\b/);
});

it('keeps every later migration free of bare CASE and the lifecycle triggers free of CASE', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const name of (await readdir('worker/migrations')).filter(n => n >= '0003')) {
    const sql = (await readFile(`worker/migrations/${name}`, 'utf8')).replace(/--[^\n]*/g, '');
    // Any CASE must open right after a parenthesis, wherever it appears in a trigger.
    expect(sql.replace(/\(\s*CASE\b/g, '('), name).not.toMatch(/\bCASE\b/);
  }
  const lifecycle = (await readFile('worker/migrations/0008_run_lifecycle.sql', 'utf8')).replace(/--[^\n]*/g, '');
  expect(lifecycle).not.toMatch(/\bCASE\b/);
});
