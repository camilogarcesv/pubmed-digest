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
export function run(userId = alice, expectedItems = 1) {
  return { id: crypto.randomUUID(), userId, profileVersion: 1, runKey: 'weekly:2026-W38', payloadHash: 'a'.repeat(64),
    kind: 'weekly' as const, expectedItems, createdAt: timestamp };
}
