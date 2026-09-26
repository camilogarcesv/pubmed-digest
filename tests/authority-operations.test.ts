import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it, vi } from 'vitest';
import { AuthorityCommand } from '../src/multiuser/authority.js';
import { authorityCommandFromEnv, authorityRequest } from '../src/operations/authority.js';
import { backendHealth, notices } from '../src/operations/backend-health.js';

const input = { VOTES_URL: 'https://example.test/votes', DIGEST_SERVICE_SECRET: 'a'.repeat(64) };
const reply = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } });

it('fails closed on maintenance and invalid or unverified health responses', async () => {
  expect(await backendHealth(input, async () => reply({ mode: 'legacy' }))).toBe('legacy');
  await expect(backendHealth(input, async () => reply({ mode: 'maintenance' }))).rejects.toThrow();
  await expect(backendHealth(input, async () => reply({ mode: 'd1', verified: false }))).rejects.toThrow();
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
    return String(url).endsWith('/mode') ? reply({ mode: 'd1' }) : reply({ verified: true, counts: {} });
  });
  expect(await backendHealth(input, fetcher)).toBe('d1');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('validates authority commands before HTTP and never exposes rejected response bodies', async () => {
  const fetcher = vi.fn(async () => new Response('private detail', { status: 409 }));
  await expect(authorityRequest(input.VOTES_URL, input.DIGEST_SERVICE_SECRET, { action: 'activate' }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(authorityRequest(input.VOTES_URL, input.DIGEST_SERVICE_SECRET, undefined, fetcher)).rejects.toThrow('Authority request refused');
});
it('serializes authority, deployment and digest; D1 jobs cannot write state or reach Telegram', () => {
  const workflows = ['authority', 'deploy-worker', 'digest'].map(name => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')));
  for (const workflow of workflows) expect(workflow.concurrency).toEqual({ group: 'pubmed-digest', 'cancel-in-progress': false });
  expect(workflows[0].on).toHaveProperty('workflow_dispatch');
  expect(workflows[0].jobs.authority.environment).toBe('production');
  const digest = workflows[2];
  expect(digest.permissions).toEqual({ contents: 'read' });
  expect(digest.jobs.digest.if).toBe("needs.backend.outputs.mode == 'legacy'");
  const d1 = digest.jobs['digest-d1'];
  expect(d1.if).toBe("needs.backend.outputs.mode == 'd1'");
  expect(d1.environment).toBe('digest');
  const serialized = JSON.stringify(d1);
  for (const denied of ['TELEGRAM_', 'VOTES_READ_SECRET', 'state.json', 'git push', 'contents":"write']) expect(serialized).not.toContain(denied);
  expect(serialized).toContain('--backend d1');
  expect(serialized).not.toContain('--dry-run');
  expect(d1.steps.at(-1)).toMatchObject({ if: 'failure()', run: 'pnpm d1:health -- --notify digest' });
});
it('offers every audited operation behind the same production protection as a release', () => {
  const authority = parse(readFileSync('.github/workflows/authority.yml', 'utf8'));
  const deploy = parse(readFileSync('.github/workflows/deploy-worker.yml', 'utf8'));
  const actions = AuthorityCommand.options.map(o => o.shape.action.value);
  expect([...authority.on.workflow_dispatch.inputs.action.options].sort()).toEqual([...actions].sort());
  const job = authority.jobs.authority;
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(job.permissions).toEqual({ contents: 'read', actions: 'read' });
  const protection = (steps: Array<{ name?: string; run?: string }>) => steps.find(s => s.name === 'Verify deployment protection')?.run;
  expect(protection(job.steps)).toBeDefined();
  expect(protection(job.steps)).toBe(protection(deploy.jobs.deploy.steps));
  // Protection is checked before anything reaches the Worker.
  expect(job.steps.findIndex((s: { name?: string }) => s.name === 'Verify deployment protection'))
    .toBeLessThan(job.steps.findIndex((s: { name?: string }) => s.name === 'Execute audited authority operation'));
});
it('builds each audited command from the workflow inputs', () => {
  const base = { AUTHORITY_OPERATION_ID: crypto.randomUUID(), AUTHORITY_EXPECTED_MODE: 'maintenance', GITHUB_ACTOR: 'operator', AUTHORITY_REASON: 'test',
    GITHUB_SHA: 'a'.repeat(40), DIGEST_IMPORT_ID: crypto.randomUUID(), AUTHORITY_STATE_SHA: 'b'.repeat(40), AUTHORITY_FIRST_PERIOD: '2026-W41',
    AUTHORITY_PROOF_HASH: 'c'.repeat(64), AUTHORITY_CLAIM_ID: crypto.randomUUID(), AUTHORITY_EVIDENCE_HASH: 'd'.repeat(64) };
  for (const action of AuthorityCommand.options.map(o => o.shape.action.value)) {
    expect(AuthorityCommand.parse(authorityCommandFromEnv({ ...base, AUTHORITY_ACTION: action }))).toMatchObject({ action });
  }
  expect(authorityCommandFromEnv({ ...base, AUTHORITY_ACTION: 'seal' })).toMatchObject({ codeSha: base.GITHUB_SHA, importId: base.DIGEST_IMPORT_ID });
  expect(authorityCommandFromEnv({ ...base, AUTHORITY_ACTION: 'release_legacy' })).toMatchObject({ claimId: base.AUTHORITY_CLAIM_ID, evidenceHash: base.AUTHORITY_EVIDENCE_HASH });
  // Inputs of another operation never leak into a command that does not take them.
  expect(() => AuthorityCommand.parse(authorityCommandFromEnv({ ...base, AUTHORITY_ACTION: 'maintenance', AUTHORITY_EXPECTED_MODE: 'legacy' }))).not.toThrow();
  expect(() => AuthorityCommand.parse(authorityCommandFromEnv({ ...base, AUTHORITY_ACTION: 'release_legacy', AUTHORITY_EVIDENCE_HASH: '' }))).toThrow();
});
it('names the failed workflow in operator notices without run data', () => {
  expect(Object.keys(notices).sort()).toEqual(['canary', 'digest']);
  for (const text of Object.values(notices)) expect(text).toMatch(/GitHub Actions/);
  expect(notices.canary).toMatch(/canario/);
});
