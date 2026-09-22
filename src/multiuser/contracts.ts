import { z } from 'zod';

export const UserId = z.uuid();
export const Pmid = z.string().regex(/^\d{1,16}$/);
export const Timestamp = z.iso.datetime({ precision: 3 });
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const RunStatus = z.enum(['draft', 'prepared', 'delivering', 'needs_reconciliation', 'succeeded', 'aborted']);
export const DeliveryStatus = z.enum(['pending', 'sending', 'sent', 'failed', 'unknown', 'reconciled_sent', 'reconciled_retry']);
export const SystemMode = z.enum(['legacy', 'maintenance', 'd1']);

const strings = z.array(z.string().max(2000)).max(100);
// Runtime-independent: this module is shared by Node and the Worker, with no filesystem imports.
export const InterestProfile = z.strictObject({
  description: z.string().min(1).max(16000),
  topics: strings,
  must_have: strings,
  nice_to_have: strings,
  exclude: strings,
  exemplar_papers: z.array(z.strictObject({ title: z.string().min(1).max(2000), pmid: Pmid.optional() })).max(100),
  threshold: z.number().int().min(0).max(10).optional(),
});
export const Source = z.strictObject({ kind: z.enum(['journal', 'query']), value: z.string().trim().min(1).max(2000) });
export const ProfileVersion = z.strictObject({
  userId: UserId,
  version: z.number().int().positive(),
  profile: InterestProfile,
  sources: z.array(Source).max(40).refine(xs => new Set(xs.map(x => `${x.kind}:${x.value}`)).size === xs.length, 'Duplicate source'),
  createdAt: Timestamp,
});
export const User = z.strictObject({
  id: UserId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  email: z.email().transform(s => s.trim().toLowerCase()),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid timezone'),
  status: z.enum(['active', 'paused']),
  createdAt: Timestamp,
});
export const Destination = z.strictObject({
  id: z.uuid(), userId: UserId, externalId: z.string().regex(/^-?\d{1,20}$/),
  status: z.enum(['active', 'paused']), digestEnabled: z.boolean(), opsEnabled: z.boolean(),
});
export const Article = z.strictObject({
  pmid: Pmid, title: z.string().max(8000), abstract: z.string().max(100000).nullable(),
  metadata: z.record(z.string(), z.json()).nullable(), updatedAt: Timestamp,
});
export const LedgerEntry = z.strictObject({
  userId: UserId, pmid: Pmid, firstSeen: Timestamp,
  relevance: z.number().min(0).max(10).nullable(), reason: z.string().max(8000).nullable(),
  source: z.string().max(2000).nullable(), delivered: z.boolean(), deliveredAt: Timestamp.nullable(),
}).refine(e => e.delivered || e.deliveredAt === null, 'Undelivered entry cannot have a delivery timestamp');
/** ISO-8601 week, e.g. 2026-W40. A weekly run belongs to exactly one. */
export const Period = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
export const CreateRun = z.strictObject({
  id: z.uuid(), userId: UserId, profileVersion: z.number().int().positive(),
  runKey: z.string().min(1).max(100), payloadHash: Sha256,
  kind: z.enum(['weekly', 'search']), expectedItems: z.number().int().min(0).max(250), createdAt: Timestamp,
  period: Period.nullable(),
}).refine(r => r.kind === 'weekly' ? r.period !== null && r.runKey.startsWith(`weekly:${r.period}:`) : r.period === null,
  'A weekly run key names its period and attempt; other runs have no period');
export const DigestItem = z.strictObject({
  article: Article, relevance: z.number().min(0).max(10).nullable(), reason: z.string().max(8000).nullable(),
  source: z.string().max(2000), disposition: z.enum(['selected', 'near_miss', 'below_threshold', 'filtered']),
}).refine(i => (i.disposition === 'filtered') === (i.relevance === null), 'Only filtered articles have no score');
export const SeenCheck = z.strictObject({
  pairs: z.array(z.strictObject({ userId: UserId, pmid: Pmid })).min(1).max(50),
});
export const VoteInput = z.strictObject({
  userId: UserId, pmid: Pmid, destinationId: z.uuid(), value: z.union([z.literal(0), z.literal(1)]), votedAt: Timestamp,
});
export interface UserContext {
  userId: string;
  slug: string;
  timezone: string;
  profile: z.infer<typeof ProfileVersion>;
  destinationIds: string[];
  /** Subset of destinationIds that also receive operator information (cost footer, alerts). */
  opsDestinationIds: string[];
}
/** One Telegram message as rendered by the digest; the Worker adds the vote keyboard itself. */
export const OutboundMessage = z.strictObject({
  kind: z.enum(['header', 'paper', 'near_miss', 'footer', 'empty']),
  text: z.string().min(1).max(4096),
  pmid: Pmid.nullable(),
  votable: z.boolean(),
}).refine(m => (m.pmid === null) === ['header', 'footer', 'empty'].includes(m.kind), 'Only paper messages reference an article')
  .refine(m => !m.votable || m.pmid !== null, 'Only paper messages carry a vote keyboard');
/**
 * One transaction freezes every destination's messages. A full digest is at most 18 messages (header,
 * 12 papers, near-miss header, 3 near misses, footer), so the 36-message D1 budget fits 2 destinations.
 */
export const PrepareRun = z.strictObject({
  metrics: z.record(z.string(), z.json()),
  destinations: z.array(z.strictObject({ destinationId: z.uuid(), messages: z.array(OutboundMessage).min(1).max(36) })).min(1).max(2),
});
export const OpsAlert = z.strictObject({ text: z.string().trim().min(1).max(1500) });
export const ResolveMessage = z.strictObject({
  action: z.enum(['mark_sent', 'retry']),
  actor: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
  telegramMessageId: z.string().regex(/^\d{1,20}$/).nullable(),
}).refine(r => r.action === 'mark_sent' || r.telegramMessageId === null, 'Only a confirmed delivery has a Telegram message id');
export type DeliveryState = 'sent' | 'retry' | 'busy' | 'blocked' | 'destination_done' | 'done';
export interface DeliveryOutcome {
  state: DeliveryState;
  /** Seconds Telegram asked to wait before the next attempt (flood control). */
  retryAfter?: number;
  /** Message awaiting reconciliation when state is blocked. */
  messageId?: string;
}
export interface RunProgress {
  id: string; userId: string; runKey: string; period: string | null; status: z.infer<typeof RunStatus>;
  expectedItems: number; items: number; messages: Record<string, number>;
}
export interface EvalVote {
  pmid: string; title: string; value: 0 | 1; score: number | null; votedAt: string;
}
export interface RunRecord {
  id: string; userId: string; status: z.infer<typeof RunStatus>; payloadHash: string; expectedItems: number;
  kind: 'weekly' | 'search'; profileVersion: number; period: string | null; runKey: string;
}
export class DomainError extends Error {
  constructor(public readonly code: 'not_found' | 'conflict' | 'invalid_input', message: string) {
    super(message); this.name = 'DomainError';
  }
}
/** No ambient/default user: every tenant operation requires an explicit user identifier. */
export interface DigestRepository {
  contexts(): Promise<UserContext[]>;
  seen(input: z.infer<typeof SeenCheck>): Promise<boolean[]>;
  evalContext(userId: string): Promise<EvalVote[]>;
  createRun(input: z.infer<typeof CreateRun>): Promise<RunRecord>;
  getRun(userId: string, runId: string): Promise<RunRecord>;
  putItems(userId: string, runId: string, chunkIndex: number, items: z.infer<typeof DigestItem>[]): Promise<void>;
}
