import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/deploy-worker.yml', 'utf8'));
const protection = workflow.jobs.deploy.steps.find((step: { name?: string }) => step.name === 'Verify deployment protection');
const checks = [...protection.run.matchAll(/node --input-type=module -e '([\s\S]*?)'/g)].map(match => match[1]);
const accepts = (index: number, input: unknown) => spawnSync(process.execPath, ['--input-type=module', '-e', checks[index]], {
  input: JSON.stringify(input), encoding: 'utf8',
}).status === 0;

it('requires manual main deployment, an immutable SHA and serialized non-cancelling releases', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.jobs.validate.if).toBe("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.deploy.needs).toBe('validate');
  expect(workflow.jobs.deploy.environment).toBe('production');
  expect(workflow.jobs.deploy.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(workflow.concurrency).toEqual({ group: 'pubmed-digest', 'cancel-in-progress': false });
  for (const job of Object.values(workflow.jobs) as Array<{ steps: Array<{ uses?: string; with?: unknown }> }>) {
    expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
  }
});
it('fails closed without a reviewer and selected deployment policies', () => {
  expect(checks).toHaveLength(2);
  expect(accepts(0, { protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }], deployment_branch_policy: { custom_branch_policies: true } })).toBe(true);
  expect(accepts(0, {})).toBe(false);
  expect(accepts(0, { protection_rules: [{ type: 'required_reviewers', reviewers: [] }], deployment_branch_policy: { custom_branch_policies: true } })).toBe(false);
});
it('accepts the documented GitHub policy response without a type but rejects additional rules or tags', () => {
  expect(accepts(1, { total_count: 1, branch_policies: [{ id: 1, name: 'main' }] })).toBe(true);
  expect(accepts(1, { total_count: 1, branch_policies: [{ id: 1, name: 'main', type: 'branch' }] })).toBe(true);
  expect(accepts(1, { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] })).toBe(false);
  expect(accepts(1, { total_count: 2, branch_policies: [{ name: 'main' }] })).toBe(false);
  expect(accepts(1, { total_count: 1, branch_policies: [{ name: '*' }] })).toBe(false);
});
