import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { backendOrigin, httpBackend } from '../backend/client.js';
import { SystemMode } from '../multiuser/contracts.js';
import { stripArgSeparator } from '../util.js';

export async function backendHealth(input = process.env, fetcher: typeof fetch = fetch) {
  const origin = backendOrigin(input.DIGEST_API_ORIGIN || input.VOTES_URL || '');
  const secret = input.DIGEST_SERVICE_SECRET ?? '';
  if (secret.length < 32) throw new Error('Credential required');
  const get = async (path: string) => {
    const response = await fetcher(`${origin}/internal/v1${path}`, {
      headers: { authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error('Health check refused');
    return response.json();
  };
  const { mode } = z.object({ mode: SystemMode }).parse(await get('/mode'));
  if (mode === 'maintenance') throw new Error('Maintenance active');
  if (mode === 'd1') z.object({ verified: z.literal(true) }).parse(await get('/health'));
  return mode;
}
/** Operator notices sent through the Worker: where to look, never run data. */
export const notices = {
  digest: '⚠️ El digest semanal de PubMed falló. Revisa GitHub Actions.',
  canary: '🐤 El canario del sábado falló. Revisa GitHub Actions antes del lunes.',
} as const;
async function main() {
  const { values } = parseArgs({ args: stripArgSeparator(process.argv.slice(2)), options: { notify: { type: 'string' } } });
  if (values.notify !== undefined) {
    const text = z.enum(['digest', 'canary']).transform(key => notices[key]).parse(values.notify);
    const origin = process.env.DIGEST_API_ORIGIN || process.env.VOTES_URL || '';
    const result = await httpBackend(origin, process.env.DIGEST_SERVICE_SECRET ?? '').opsAlert(text);
    if (!result.sent || result.failed) throw new Error('Notification failed');
    return;
  }
  const mode = await backendHealth();
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
  console.log(JSON.stringify({ mode, healthy: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Backend check or notification failed.'); process.exitCode = 1; });
}
