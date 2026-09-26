import { env } from 'cloudflare:workers';
import { D1DigestRepository } from '../multiuser/repository.js';
import type { Article, DigestItem, LedgerEntry } from '../../src/multiuser/contracts.js';
import type { z } from 'zod';

export const alice = '11111111-1111-4111-8111-111111111111';
export const bob = '22222222-2222-4222-8222-222222222222';
export const aliceDestination = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const bobDestination = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const timestamp = '2026-09-15T12:00:00.000Z';
export const profile = {
  description: 'Perfil sintético de prueba', topics: ['MRI'], must_have: [], nice_to_have: [],
  exclude: [], exemplar_papers: [], threshold: 7,
};
export async function seedUsers(): Promise<D1DigestRepository> {
  const repository = new D1DigestRepository(env.DB);
  for (const [id, slug, target, chat] of [[alice, 'alice', aliceDestination, '100'], [bob, 'bob', bobDestination, '200']]) {
    await repository.createUser({ id, slug, email: `${slug}@example.test`, timezone: 'America/Bogota', status: 'active', createdAt: timestamp },
      { userId: id, version: 1, profile, sources: [{ kind: 'journal', value: 'AJNR' }], createdAt: timestamp },
      { id: target, userId: id, externalId: chat, status: 'active', digestEnabled: true, opsEnabled: false });
  }
  return repository;
}
export function article(pmid = '123'): z.infer<typeof Article> {
  return { pmid, title: `Paper ${pmid}`, abstract: null, metadata: null, updatedAt: timestamp };
}
export function ledger(userId: string, pmid = '123', relevance = 9): z.infer<typeof LedgerEntry> {
  return { userId, pmid, relevance, firstSeen: timestamp, reason: null, source: null, delivered: true, deliveredAt: null };
}
export function item(pmid = '123'): z.infer<typeof DigestItem> {
  return { article: article(pmid), relevance: 9, reason: 'Relevante', source: 'AJNR', disposition: 'selected' };
}
export function run(userId = alice, expectedItems = 1, attempt = 1) {
  return { id: crypto.randomUUID(), userId, profileVersion: 1, runKey: `weekly:2026-W38:${attempt}`, payloadHash: 'a'.repeat(64),
    kind: 'weekly' as const, expectedItems, createdAt: timestamp, period: '2026-W38' as string | null };
}
/** Digest writes require D1 to be the operating mode; tests reset it to legacy before each case. */
export async function d1Mode(mode: 'legacy' | 'maintenance' | 'd1' = 'd1'): Promise<void> {
  await env.DB.prepare('UPDATE system_controls SET mode=? WHERE singleton=1').bind(mode).run();
}
/** Walk a run through valid lifecycle states with direct SQL, bypassing the repository. */
export async function advanceRun(runId: string, ...statuses: string[]): Promise<void> {
  for (const status of statuses) await env.DB.prepare('UPDATE digest_runs SET status=? WHERE id=?').bind(status, runId).run();
}
/** Empty every table in FK order and return to legacy mode. */
export async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    ...['authority_checkpoint', 'authority_events', 'legacy_vote_inflight', 'telegram_vote_updates', 'digest_assertions', 'ledger_extension_blocks', 'ledger_extensions', 'vote_reconciliations', 'import_blocks', 'import_sessions', 'operation_assertions',
      'operation_lock', 'delivery_resolutions', 'votes', 'delivery_messages', 'user_articles', 'digest_items', 'digest_chunks',
      'digest_runs', 'data_imports', 'destinations', 'profile_sources', 'profile_versions', 'users', 'articles']
      .map(table => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("UPDATE system_controls SET mode='legacy' WHERE singleton=1"),
  ]);
}
