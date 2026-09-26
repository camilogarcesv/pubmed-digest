import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { backendOrigin } from '../backend/client.js';
import { AuthorityCommand } from '../multiuser/authority.js';
import { SystemMode } from '../multiuser/contracts.js';
import { stripArgSeparator } from '../util.js';

export async function authorityRequest(origin: string, secret: string, command?: unknown, fetcher: typeof fetch = fetch) {
  if (secret.length < 32) throw new Error('Administrative credential required');
  const response = await fetcher(`${backendOrigin(origin)}/internal/v1/admin/authority`, {
    method: command === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: command === undefined ? undefined : JSON.stringify(AuthorityCommand.parse(command)),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error('Authority request refused');
  return z.object({ mode: SystemMode, legacyWrites: z.number().int().nonnegative(), sending: z.number().int().nonnegative(),
    pendingLegacy: z.array(z.object({ id: z.uuid(), startedAt: z.string() })),
    checkpoint: z.object({ proofHash: z.string().regex(/^[a-f0-9]{64}$/), firstPeriod: z.string(), activatedAt: z.string().nullable() }).nullable(),
  }).parse(await response.json());
}
/** The audited command of the protected workflow, from its inputs; the Worker validates it again. */
export function authorityCommandFromEnv(input: NodeJS.ProcessEnv): unknown {
  const action = input.AUTHORITY_ACTION;
  return { id: input.AUTHORITY_OPERATION_ID, action,
    expectedMode: input.AUTHORITY_EXPECTED_MODE, actor: input.GITHUB_ACTOR, reason: input.AUTHORITY_REASON,
    ...(action === 'seal' ? { importId: input.DIGEST_IMPORT_ID,
      codeSha: input.GITHUB_SHA, stateSha: input.AUTHORITY_STATE_SHA, firstPeriod: input.AUTHORITY_FIRST_PERIOD } : {}),
    ...(action === 'activate' ? { proofHash: input.AUTHORITY_PROOF_HASH, stateSha: input.AUTHORITY_STATE_SHA } : {}),
    ...(action === 'release_legacy' ? { claimId: input.AUTHORITY_CLAIM_ID, evidenceHash: input.AUTHORITY_EVIDENCE_HASH } : {}),
  };
}
async function main() {
  const { values } = parseArgs({ args: stripArgSeparator(process.argv.slice(2)), options: {
    origin: { type: 'string' }, request: { type: 'string' },
  } });
  let command: unknown = values.request ? JSON.parse(await readFile(values.request, 'utf8')) : undefined;
  if (process.env.AUTHORITY_ACTION) {
    if (values.request) throw new Error('Choose one request source');
    command = authorityCommandFromEnv(process.env);
  }
  const result = await authorityRequest(values.origin ?? process.env.VOTES_URL ?? '', process.env.IMPORT_SERVICE_SECRET ?? '', command);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Authority operation failed; inspect status before repeating the same request.'); process.exitCode = 1; });
}
