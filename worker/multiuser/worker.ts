import { z } from 'zod';
import { LedgerExtensionRepository } from './ledger-extensions.js';
import { LedgerManifest, LedgerBlock } from '../../src/multiuser/ledger-extension.js';
import { CreateRun, DigestItem, DomainError, Period, SeenCheck, SystemMode, UserId } from '../../src/multiuser/contracts.js';
import { ImportRepository } from './imports.js';
import { ImportLease, ImportManifest } from '../../src/multiuser/import-contracts.js';
import { VoteReconciliationRepository } from './reconciliations.js';
import { D1DigestRepository } from './repository.js';
import { RunRepository, type TelegramFetch } from './runs.js';

// Binding shape comes from generated configuration; this handler works in either entrypoint.
type BackendEnv = Pick<Cloudflare.Env, 'DB'> & { DIGEST_SERVICE_SECRET?: string; IMPORT_SERVICE_SECRET?: string; VOTES_READ_SECRET?: string; TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_BOT_TOKEN?: string };
const MAX_BODY = 256 * 1024;
class RequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, 'unsupported_media_type', 'Se requiere application/json.');
  }
  if (!request.body) throw new RequestError(400, 'invalid_input', 'Falta el cuerpo JSON.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new RequestError(413, 'body_too_large', 'El cuerpo excede 256 KiB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new RequestError(400, 'invalid_input', 'JSON inválido.'); }
}
async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 4096) return false;
  const encode = (s: string) => new TextEncoder().encode(s);
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(header.slice(7))), crypto.subtle.digest('SHA-256', encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

/** Reads work in every mode; digest writes, deliveries and alerts only while D1 operates. */
async function requireD1(db: D1Database): Promise<void> {
  const row = await db.prepare('SELECT mode FROM system_controls WHERE singleton=1').first<{ mode: string }>();
  if (row?.mode !== 'd1') throw new RequestError(409, 'mode_unavailable', 'El modo actual no admite esta operación.');
}
const empty = z.strictObject({});

/** Separate digest, read and administrative capabilities. Telegram is reached only through fetchImpl. */
export function createBackend(fetchImpl: TelegramFetch = (input, init) => fetch(input, init)) {
  return {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const path = new URL(request.url).pathname;
      if (path === '/internal/v1/imports' || path.startsWith('/internal/v1/imports/') || path.startsWith('/internal/v1/admin/')) {
        const secret = env.IMPORT_SERVICE_SECRET;
        if (!secret || [env.DIGEST_SERVICE_SECRET, env.VOTES_READ_SECRET, env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_BOT_TOKEN].includes(secret)
          || !(await authorized(request, secret))) throw new RequestError(401, 'unauthorized', 'No autorizado.');
        const resolve = /^\/internal\/v1\/admin\/users\/([^/]+)\/digest-runs\/([^/]+)\/messages\/([^/]+)\/resolve$/.exec(path);
        if (resolve && request.method === 'POST') {
          await requireD1(env.DB);
          const runs = new RunRepository(env.DB, { token: env.TELEGRAM_BOT_TOKEN, fetch: fetchImpl });
          return json(await runs.resolve(UserId.parse(resolve[1]), resolve[2], resolve[3], await readJson(request)));
        }
        if (path.startsWith('/internal/v1/admin/')) throw new RequestError(404, 'not_found', 'Ruta no encontrada.');
        const imports = new ImportRepository(env.DB);
        if (['/internal/v1/imports/lease', '/internal/v1/imports/lease/renew'].includes(path) && request.method === 'POST') {
          const { owner } = ImportLease.parse(await readJson(request));
          await imports.lease(owner, path.endsWith('/renew')); return json({ acquired: true });
        }
        if (path === '/internal/v1/imports/lease' && request.method === 'DELETE') {
          const { owner } = ImportLease.parse(await readJson(request));
          await imports.release(owner); return json({ released: true });
        }
        if (path === '/internal/v1/imports' && request.method === 'POST') {
          const { owner, manifest } = z.strictObject({ owner: z.uuid(), manifest: ImportManifest }).parse(await readJson(request));
          return json(await imports.create(owner, manifest));
        }
        const ledger = /^\/internal\/v1\/imports\/users\/([^/]+)\/ledger(?:-extensions(?:\/([^/]+)(?:\/(blocks|finalize|verify))?)?)?$/.exec(path);
        if (ledger) {
          const userId = UserId.parse(ledger[1]), repository = new LedgerExtensionRepository(env.DB);
          if (request.method === 'GET' && path.endsWith('/ledger')) return json(await repository.snapshot(userId));
          if (!ledger[2] && request.method === 'POST' && path.endsWith('/ledger-extensions')) {
            const { owner, manifest } = z.strictObject({ owner: z.uuid(), manifest: LedgerManifest }).parse(await readJson(request));
            return json(await repository.create(owner, userId, manifest));
          }
          if (ledger[2]) {
            const id = z.uuid().parse(ledger[2]);
            if (!ledger[3] && request.method === 'GET') return json(await repository.status(userId, id));
            if (ledger[3] === 'verify' && request.method === 'GET') return json(await repository.verify(userId, id));
            if (ledger[3] === 'blocks' && request.method === 'POST') {
              const { owner, block } = z.strictObject({ owner: z.uuid(), block: LedgerBlock }).parse(await readJson(request));
              return json(await repository.put(owner, userId, id, block));
            }
            if (ledger[3] === 'finalize' && request.method === 'POST') {
              const { owner } = ImportLease.parse(await readJson(request));
              return json(await repository.finalize(owner, userId, id));
            }
          }
          throw new RequestError(404, 'not_found', 'Ruta no encontrada.');
        }
        // Legacy vote reconciliation: KV capture -> D1 copy, same credential and lease as the import.
        const reconcile = /^\/internal\/v1\/imports\/users\/([^/]+)\/vote-reconciliations(?:\/(plan|verify))?$/.exec(path);
        if (reconcile) {
          const userId = UserId.parse(reconcile[1]);
          const reconciliations = new VoteReconciliationRepository(env.DB);
          if (request.method === 'POST' && reconcile[2] === 'plan') {
            const { capture } = z.strictObject({ capture: z.unknown() }).parse(await readJson(request));
            return json(await reconciliations.plan(userId, capture));
          }
          if (request.method === 'POST' && !reconcile[2]) {
            const { owner, capture } = z.strictObject({ owner: z.uuid(), capture: z.unknown() }).parse(await readJson(request));
            return json(await reconciliations.apply(owner, userId, capture));
          }
          if (request.method === 'GET' && reconcile[2] === 'verify') return json(await reconciliations.verify(userId));
          throw new RequestError(404, 'not_found', 'Ruta no encontrada.');
        }
        const match = /^\/internal\/v1\/imports\/([a-f0-9-]+)(?:\/(blocks|verify|finalize))?$/.exec(path);
        if (match) {
          const id = z.uuid().parse(match[1]);
          if (request.method === 'GET' && !match[2]) return json(await imports.status(id));
          if (request.method === 'GET' && match[2] === 'verify') return json(await imports.verify(id));
          if (request.method === 'POST' && match[2] === 'blocks') {
            const { owner, block } = z.strictObject({ owner: z.uuid(), block: z.unknown() }).parse(await readJson(request));
            return json(await imports.put(owner, id, block));
          }
          if (request.method === 'POST' && match[2] === 'finalize') {
            const { owner } = ImportLease.parse(await readJson(request));
            return json(await imports.verify(id, owner));
          }
        }
        throw new RequestError(404, 'not_found', 'Ruta no encontrada.');
      }
      if (!(await authorized(request, env.DIGEST_SERVICE_SECRET))) throw new RequestError(401, 'unauthorized', 'No autorizado.');
      const repository = new D1DigestRepository(env.DB);
      if (request.method === 'GET' && path === '/internal/v1/mode') {
        const row = await env.DB.prepare('SELECT mode FROM system_controls WHERE singleton=1').first<{ mode: string }>();
        return json({ mode: SystemMode.parse(row?.mode) });
      }
      if (request.method === 'GET' && path === '/internal/v1/contexts') return json({ users: await repository.contexts() });
      if (request.method === 'POST' && path === '/internal/v1/seen/check') return json({ seen: await repository.seen(SeenCheck.parse(await readJson(request))) });
      const match = /^\/internal\/v1\/users\/([^/]+)\/eval-context$/.exec(path);
      if (request.method === 'GET' && match) return json({ votes: await repository.evalContext(UserId.parse(match[1])) });
      const runs = new RunRepository(env.DB, { token: env.TELEGRAM_BOT_TOKEN, fetch: fetchImpl });
      const context = /^\/internal\/v1\/users\/by-slug\/([^/]+)\/context$/.exec(path);
      if (request.method === 'GET' && context) return json({ user: await runs.context(context[1]) });
      if (request.method === 'POST' && path === '/internal/v1/ops/alerts') {
        await requireD1(env.DB);
        return json(await runs.opsAlert(await readJson(request)));
      }
      const route = /^\/internal\/v1\/users\/([^/]+)\/digest-runs(?:\/([^/]+)(?:\/(items\/\d{1,3}|prepare|abort|destinations\/[^/]+\/deliver))?)?$/.exec(path);
      if (route) {
        const userId = UserId.parse(route[1]), runId = route[2], action = route[3];
        if (request.method === 'GET' && !runId) {
          return json({ runs: await runs.runs(userId, Period.parse(new URL(request.url).searchParams.get('period'))) });
        }
        if (request.method === 'GET' && runId && !action) return json(await runs.progress(userId, runId));
        if (request.method === 'GET') throw new RequestError(405, 'method_not_allowed', 'Método no permitido.');
        await requireD1(env.DB);
        if (request.method === 'POST' && !runId) {
          const run = CreateRun.parse(await readJson(request));
          if (run.userId !== userId) throw new DomainError('invalid_input', 'Owner mismatch');
          return json({ run: await repository.createRun(run) });
        }
        if (request.method === 'PUT' && action?.startsWith('items/')) {
          const { items } = z.strictObject({ items: z.array(DigestItem) }).parse(await readJson(request));
          await repository.putItems(userId, z.uuid().parse(runId), Number(action.slice(6)), items);
          return json({ stored: true });
        }
        if (request.method === 'POST' && action === 'prepare') return json(await runs.prepare(userId, z.uuid().parse(runId), await readJson(request)));
        if (request.method === 'POST' && action === 'abort') {
          empty.parse(await readJson(request));
          return json(await runs.abort(userId, z.uuid().parse(runId)));
        }
        if (request.method === 'POST' && action?.startsWith('destinations/')) {
          empty.parse(await readJson(request));
          return json(await runs.deliverNext(userId, z.uuid().parse(runId), action.split('/')[1]));
        }
      }
      throw new RequestError(404, 'not_found', 'Ruta no encontrada.');
    } catch (error) {
      let status = 500, code = 'internal_error', message = 'Error interno.';
      if (error instanceof RequestError) ({ status, code, message } = error);
      else if (error instanceof z.ZodError) { status = 400; code = 'invalid_input'; message = 'Entrada inválida.'; }
      else if (error instanceof DomainError) {
        status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
        code = error.code; message = 'La operación no pudo completarse.';
      }
      // No request bodies, URLs, SQL, email/chat identifiers or raw exception messages.
      if (status === 500) console.error(JSON.stringify({ event: 'internal_api_error', requestId }));
      return json({ error: { code, message, requestId } }, status);
    }
  },
  };
}

export default createBackend();
