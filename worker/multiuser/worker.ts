import { z } from 'zod';
import { DomainError, SeenCheck, SystemMode, UserId } from '../../src/multiuser/contracts.js';
import { D1DigestRepository } from './repository.js';

// These secrets will be provisioned in 2.2; never default to a development credential.
type BackendEnv = LocalEnv & { DIGEST_SERVICE_SECRET?: string };
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

/** Read API only in 2.1. It has a separate local entrypoint and cannot send Telegram messages. */
export default {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      if (!(await authorized(request, env.DIGEST_SERVICE_SECRET))) throw new RequestError(401, 'unauthorized', 'No autorizado.');
      const path = new URL(request.url).pathname;
      const repository = new D1DigestRepository(env.DB);
      if (request.method === 'GET' && path === '/internal/v1/mode') {
        const row = await env.DB.prepare('SELECT mode FROM system_controls WHERE singleton=1').first<{ mode: string }>();
        return json({ mode: SystemMode.parse(row?.mode) });
      }
      if (request.method === 'GET' && path === '/internal/v1/contexts') return json({ users: await repository.contexts() });
      if (request.method === 'POST' && path === '/internal/v1/seen/check') return json({ seen: await repository.seen(SeenCheck.parse(await readJson(request))) });
      const match = /^\/internal\/v1\/users\/([^/]+)\/eval-context$/.exec(path);
      if (request.method === 'GET' && match) return json({ votes: await repository.evalContext(UserId.parse(match[1])) });
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
} satisfies ExportedHandler<BackendEnv>;
