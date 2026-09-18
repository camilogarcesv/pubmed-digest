import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { commandFailure, formatReleaseFailure, ReleaseFailure, releaseFailure } from '../src/operations/release-diagnostics.js';

it('emits fixed labels instead of provider output, credentials or raw validation messages', () => {
  const secret = 'private-secret-must-never-appear';
  const error = Object.assign(new Error(secret), {
    stdout: `${secret} incomplete input: SQLITE_ERROR [code: 7500]`,
    stderr: `https://private.example/${secret} SELECT sensitive_data`,
  });
  const report = formatReleaseFailure(releaseFailure('migrate', commandFailure(error)));
  expect(JSON.parse(report)).toEqual({ event: 'worker_release_failed', stage: 'migrate', code: 'sql_incomplete_input', recovery: 'not_attempted' });
  expect(report).not.toContain(secret);
  expect(formatReleaseFailure(releaseFailure('prepare', new Error(secret)))).not.toContain(secret);
  expect(commandFailure(new Error(secret)).code).toBe('provider_command_failed');
});

it('does not trust arbitrary errors or mutated diagnostic labels', () => {
  const error = new ReleaseFailure('prepare', 'step_failed');
  Object.assign(error, { stage: 'private-id', code: 'private-token', recovery: 'private-url' });
  for (const value of [error, new Error('private'), { stage: 'migrate', code: 'private' }, null]) {
    expect(JSON.parse(formatReleaseFailure(value))).toEqual({
      event: 'worker_release_failed', stage: 'unknown', code: 'step_failed', recovery: 'manual_reconciliation',
    });
  }
});

it('prints only a sanitized preparation failure and exits nonzero at the CLI boundary', () => {
  let failure: unknown;
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'src/operations/deploy-worker.ts'], {
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'private-invalid-input' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 1, stdout: '' });
  const stderr = (failure as { stderr: string }).stderr;
  expect(JSON.parse(stderr)).toEqual({
    event: 'worker_release_failed', stage: 'prepare', code: 'step_failed', recovery: 'not_attempted',
  });
  expect(stderr).not.toContain('private-invalid-input');
});
