import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BackendError, backendOrigin, httpBackend, type DigestBackend } from '../backend/client.js';
import { OpsAlertResult, SystemMode } from '../multiuser/contracts.js';
import { stripArgSeparator } from '../util.js';
import { writeStepSummary } from '../metrics.js';

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
const Notice = z.enum(['digest', 'canary']);
const Stage = z.enum(['backend', 'digest', 'canary', 'workflow']);

export function noticeText(kind: string, stage: string, input: NodeJS.ProcessEnv = process.env): string {
  const lines = [notices[Notice.parse(kind)], `Etapa: ${Stage.parse(stage)}.`];
  // Never accept an arbitrary URL or untrusted free text in an operational alert.
  if (input.GITHUB_SERVER_URL === 'https://github.com' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.GITHUB_REPOSITORY ?? '') && /^\d+$/.test(input.GITHUB_RUN_ID ?? '')) {
    lines.push(`https://github.com/${input.GITHUB_REPOSITORY}/actions/runs/${input.GITHUB_RUN_ID}`);
  }
  return lines.join('\n');
}

export async function notifyOperator(backend: Pick<DigestBackend, 'opsAlert'>, kind: string, stage: string, input = process.env) {
  const result = OpsAlertResult.parse(await backend.opsAlert(noticeText(kind, stage, input)));
  const report = { event: 'operator_notification', stage: Stage.parse(stage), ...result };
  console.log(JSON.stringify(report));
  writeStepSummary(`### Operator notification\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`);
  if (!result.sent || result.failed) throw new Error('Notification failed');
  return result;
}
async function main() {
  const { values } = parseArgs({ args: stripArgSeparator(process.argv.slice(2)), options: { notify: { type: 'string' }, stage: { type: 'string', default: 'workflow' } } });
  if (values.notify !== undefined) {
    const origin = process.env.DIGEST_API_ORIGIN || process.env.VOTES_URL || '';
    await notifyOperator(httpBackend(origin, process.env.DIGEST_SERVICE_SECRET ?? ''), values.notify, values.stage);
    return;
  }
  const mode = await backendHealth();
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
  console.log(JSON.stringify({ mode, healthy: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const report = { event: 'backend_check_or_notification_failed', ...(error instanceof BackendError ? { httpStatus: error.status } : {}) };
    console.error(JSON.stringify(report));
    writeStepSummary(`### Backend check or notification failed\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`);
    process.exitCode = 1;
  });
}
