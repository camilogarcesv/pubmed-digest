import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ImportManifest, checksum } from '../multiuser/import-contracts.js';
import { MAX_STEP_CHANGES, VoteCapture, parseCapture } from '../multiuser/vote-reconciliation.js';
import { fetchStrictVotes, importClient, privatePath } from './import-user.js';

// Operator workflow for 2.3b: copy a strict KV capture into D1 while KV stays the authority.
//   capture -> plan (read-only, review it) -> apply (leased, sealed steps) -> verify (full replay)
// Captures live next to the import package they reconcile; nothing is ever overwritten.

const exec = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const Plan = z.object({
  counts: z.object({ captured: z.number(), unmapped: z.number(), new: z.number(), update: z.number(), unchanged: z.number(), unresolved: z.number(), conflict: z.number(), d1Only: z.number() }),
  changes: z.array(z.unknown()),
}).passthrough();
const Verification = z.object({ verified: z.literal(true), reconciliations: z.number().int().nonnegative(), votes: z.number().int().nonnegative() });
const Step = z.object({ applied: z.boolean(), changed: z.number().int().min(0), remaining: z.number().int().min(0) }).passthrough();
type Request = ReturnType<typeof importClient>;

/**
 * Apply a capture in sealed steps under one import lease. Refuses up front when the plan has
 * conflicts or D1-only votes: those need a human decision, never an automatic overwrite.
 */
export async function applyCapture(userId: string, capture: VoteCapture, request: Request) {
  const base = `/users/${userId}/vote-reconciliations`;
  const readPlan = async () => {
    const plan = Plan.parse(await request(`${base}/plan`, { capture }));
    if (plan.counts.conflict || plan.counts.d1Only) throw new Error('Reconciliation blocked by conflicts; review the plan');
    return plan;
  };
  let plan = await readPlan();
  if (!plan.changes.length) return { plan: plan.counts, steps: 0, changed: 0, verify: Verification.parse(await request(`${base}/verify`)) };
  const owner = crypto.randomUUID();
  await request('/lease', { owner });
  try {
    const baseline = Verification.parse(await request(`${base}/verify`));
    // Refresh after taking the lease: another operator may have committed since the preview.
    plan = await readPlan();
    for (let attempt = 0, remaining = plan.changes.length; remaining > 0; attempt++) {
      if (attempt > Math.ceil(plan.changes.length / MAX_STEP_CHANGES)) throw new Error('Reconciliation did not converge');
      await request('/lease/renew', { owner });
      try { remaining = Step.parse(await request(base, { owner, capture })).remaining; }
      catch {
        // Observe the committed checkpoint before retrying an unknown outcome. The final
        // sequence difference includes successful commits whose response was lost.
        await request('/lease/renew', { owner });
        await request(`${base}/verify`);
        remaining = (await readPlan()).changes.length;
        if (remaining) remaining = Step.parse(await request(base, { owner, capture })).remaining;
      }
    }
    const verify = Verification.parse(await request(`${base}/verify`));
    // Verify while the lease still excludes other writers, so these counts describe this run.
    return { plan: plan.counts, steps: verify.reconciliations - baseline.reconciliations, changed: plan.changes.length, verify };
  } finally { await request('/lease', { owner }, 'DELETE'); }
}

async function packageUser(dir: string) {
  return ImportManifest.parse(JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'))).identity;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    package: { type: 'string' }, capture: { type: 'string' }, origin: { type: 'string' }, 'code-sha': { type: 'string' },
  } });
  const command = z.enum(['capture', 'plan', 'apply', 'verify']).parse(positionals[0]);
  if (!values.origin) throw new Error('Worker origin required');
  const stamp = new Date().toISOString();

  if (command === 'capture') {
    if (!values.package || !values['code-sha']) throw new Error('Package and code SHA required');
    const dir = await privatePath(values.package);
    const identity = await packageUser(dir);
    const codeSha = z.string().regex(/^[a-f0-9]{40}$/).parse(values['code-sha']);
    await exec('git', ['cat-file', '-e', `${codeSha}^{commit}`]);
    const exported = await fetchStrictVotes(values.origin, z.string().min(16).parse(process.env.VOTES_READ_SECRET));
    const capture = VoteCapture.parse({ format: 1, id: crypto.randomUUID(), capturedAt: stamp, codeSha, checksum: await checksum(exported.votes), votes: exported.votes });
    await mkdir(resolve(dir, 'reconciliations'), { recursive: true, mode: 0o700 });
    const target = resolve(dir, 'reconciliations', stamp.replace(/[:.]/g, '-'));
    await mkdir(target, { mode: 0o700 }); // a reviewed capture is never overwritten
    await writeFile(resolve(target, 'export.json'), json(exported), { mode: 0o600 });
    await writeFile(resolve(target, 'capture.json'), json(capture), { mode: 0o600 });
    const own = capture.votes.filter(v => v.chatId === identity.chatId).length;
    console.log(json({ captured: capture.votes.length, forUser: own, capture: target.split('/').slice(-3).join('/') }));
    return;
  }

  const request = importClient(values.origin, process.env.IMPORT_SERVICE_SECRET ?? '');
  if (command === 'verify') {
    if (!values.package) throw new Error('Package path required');
    const dir = await privatePath(values.package);
    const result = await request(`/users/${(await packageUser(dir)).id}/vote-reconciliations/verify`);
    await writeFile(resolve(dir, `reconciliation-verify-${Date.now()}.json`), json({ at: stamp, result }), { mode: 0o600 });
    console.log(json({ completed: command, result }));
    return;
  }

  if (!values.capture) throw new Error('Capture directory required');
  const target = await privatePath(values.capture);
  if (resolve(target, '..').split('/').at(-1) !== 'reconciliations') throw new Error('Not a reconciliation capture');
  const user = await packageUser(resolve(target, '..', '..'));
  const capture = await parseCapture(JSON.parse(await readFile(resolve(target, 'capture.json'), 'utf8')));
  const result = command === 'plan'
    ? await request(`/users/${user.id}/vote-reconciliations/plan`, { capture })
    : await applyCapture(user.id, capture, request);
  await writeFile(resolve(target, `${command}-${Date.now()}.json`), json({ at: stamp, result }), { mode: 0o600 });
  // Counts only: PMIDs and vote values stay in the private files.
  const counts = command === 'plan' ? Plan.parse(result).counts : (result as Awaited<ReturnType<typeof applyCapture>>).plan;
  console.log(json({ completed: command, counts, ...(command === 'apply' ? { steps: (result as { steps: number }).steps } : {}) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ error: 'reconcile_failed', recovery: 'retain_capture_then_rerun_plan' })); process.exitCode = 1; });
}
