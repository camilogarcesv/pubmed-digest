import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorker, type WorkerEnv } from '../worker.js';
import { alice } from './fixtures.js';

const telegram = vi.fn(async () => Response.json({ ok: true }));
const worker = createWorker(telegram);
function bindings(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { DB: env.DB, VOTES: env.VOTES, TELEGRAM_BOT_TOKEN: 'test-bot',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook', VOTES_READ_SECRET: 'test-export',
    DIGEST_SERVICE_SECRET: 'test-service', CF_VERSION_METADATA: { id: 'test-version', tag: '', timestamp: '' }, ...overrides };
}
function request(path: string, secret?: string, method = 'GET', body?: string): Request {
  return new Request(`https://worker.test${path}`, { method,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), 'content-type': 'application/json' }, body });
}
const invoke = (req: Request, overrides: Partial<WorkerEnv> = {}) => worker.fetch!(
  req as Parameters<NonNullable<typeof worker.fetch>>[0], bindings(overrides), createExecutionContext());

beforeEach(async () => {
  telegram.mockClear();
  const page = await env.VOTES.list();
  for (const key of page.keys) await env.VOTES.delete(key.name);
});
afterEach(() => vi.restoreAllMocks());

it('serves all four read routes without creating business records or sending messages', async () => {
  const cases: Array<[Request, unknown]> = [
    [request('/internal/v1/mode', 'test-service'), { mode: 'legacy', version: 'test-version' }],
    [request('/internal/v1/contexts', 'test-service'), { users: [] }],
    [request('/internal/v1/seen/check', 'test-service', 'POST', JSON.stringify({ pairs: [{ userId: alice, pmid: '123' }] })), { seen: [false] }],
    [request(`/internal/v1/users/${alice}/eval-context`, 'test-service'), { votes: [] }],
  ];
  for (const [req, expected] of cases) {
    const response = await invoke(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(await response.json()).toEqual(expected);
  }
  expect(telegram).not.toHaveBeenCalled();
  for (const table of ['users', 'articles', 'votes', 'digest_runs', 'delivery_messages', 'user_articles']) {
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  }
});

it('keeps service, export and webhook credentials separate and fails closed', async () => {
  for (const secret of [undefined, 'incorrect', 'test-export', 'test-webhook']) {
    const response = await invoke(request('/internal/v1/mode', secret));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect((await invoke(request('/internal/v1/mode', 'test-service'), { DIGEST_SERVICE_SECRET: undefined })).status).toBe(401);
  expect((await invoke(request('/votes', 'test-service'))).status).toBe(403);
  expect((await invoke(new Request('https://worker.test/webhook', { method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'test-service' }, body: '{}' }))).status).toBe(403);
  expect((await env.VOTES.list()).keys).toHaveLength(0);
  expect(telegram).not.toHaveBeenCalled();
});

it('rejects invalid input and unsupported methods through the production router', async () => {
  for (const [body, status] of [['{', 400], ['"' + 'x'.repeat(256 * 1024) + '"', 413]] as const) {
    expect((await invoke(request('/internal/v1/seen/check', 'test-service', 'POST', body))).status).toBe(status);
  }
  expect((await invoke(request('/internal/v1/mode', 'test-service', 'DELETE'))).status).toBe(404);
  expect((await invoke(request('/internal/v1/runs', 'test-service', 'POST', '{}'))).status).toBe(404);
  expect((await invoke(request('/internal/v1/seen/check', 'test-service'))).status).toBe(404);
  const wrongType = request('/internal/v1/seen/check', 'test-service', 'POST', '{}');
  wrongType.headers.set('content-type', 'text/plain');
  expect((await invoke(wrongType)).status).toBe(415);
});

it('fails votes closed on a mode outage while the frozen KV export remains readable', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const outage = { DB: new Proxy(env.DB, { get() { throw new Error('private SQL and identifiers'); } }) };
  const failed = await invoke(request('/internal/v1/mode', 'test-service'), outage);
  expect(failed.status).toBe(500);
  expect(failed.headers.get('cache-control')).toBe('no-store');
  expect(await failed.text()).not.toContain('private SQL');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private SQL');
  const webhook = new Request('https://worker.test/webhook', { method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook' },
    body: JSON.stringify({ update_id: 1, callback_query: { id: 'test', data: 'v:123:1', message: { message_id: 7, chat: { id: 99 } } } }) });
  expect((await invoke(webhook, { ...outage, DIGEST_SERVICE_SECRET: undefined })).status).toBe(200);
  expect(telegram).toHaveBeenCalledTimes(1);
  const exported = await invoke(request('/votes', 'test-export'), outage);
  expect(await exported.json()).toMatchObject({ votes: [] });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM votes').first('n')).toBe(0);
});

it('guards authority operations with the import credential and reports health only for an active D1', async () => {
  const admin = 'i'.repeat(64);
  const authority = (secret?: string, method = 'GET', body?: string) =>
    invoke(request('/internal/v1/admin/authority', secret, method, body), { IMPORT_SERVICE_SECRET: admin });
  for (const secret of [undefined, 'test-service', 'test-export', 'test-webhook']) expect((await authority(secret)).status).toBe(401);
  const status = await authority(admin);
  expect(status.status).toBe(200);
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(await status.json()).toEqual({ mode: 'legacy', checkpoint: null, legacyWrites: 0, sending: 0, pendingLegacy: [] });
  expect((await authority(admin, 'POST', JSON.stringify({ action: 'activate' }))).status).toBe(400);
  const command = (action: string, expectedMode: string, extra = {}) => JSON.stringify({ id: crypto.randomUUID(), action, expectedMode, actor: 'test', reason: 'router', ...extra });
  expect((await authority(admin, 'POST', command('maintenance', 'legacy'))).status).toBe(200);
  // Only a release tagged with the sealing SHA may seal.
  const seal = command('seal', 'maintenance', { importId: crypto.randomUUID(), codeSha: 'a'.repeat(40), stateSha: 'b'.repeat(40), firstPeriod: '2099-W01' });
  expect((await authority(admin, 'POST', seal)).status).toBe(409);
  for (const secret of [undefined, admin]) {
    expect((await invoke(request('/internal/v1/health', secret), { IMPORT_SERVICE_SECRET: admin })).status).toBe(401);
  }
  const health = await invoke(request('/internal/v1/health', 'test-service'));
  expect(health.status).toBe(409);
  expect(health.headers.get('cache-control')).toBe('no-store');
  expect(telegram).not.toHaveBeenCalled();
});
