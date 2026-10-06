import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { httpBackend } from '../src/backend/client.js';
import { noticeText, notifyOperator } from '../src/operations/backend-health.js';

describe('final D1 workflow notification', () => {
  for (const name of ['digest', 'canary']) {
    const workflow = parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
    const job = workflow.jobs['notify-d1'];
    const child = `${name}-d1`;
    it.each([
      ['failure', '', 'skipped', true], ['cancelled', '', 'skipped', true],
      ['success', 'd1', 'failure', true], ['success', 'd1', 'cancelled', true],
      ['success', 'd1', 'success', false], ['success', 'legacy', 'failure', false],
      ['success', 'legacy', 'skipped', false],
    ])(`${name}: backend=%s mode=%s child=%s`, (backend, mode, childResult, expected) => {
      const expression = String(job.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replaceAll('always()', 'true')
        .replaceAll('needs.backend.result', JSON.stringify(backend))
        .replaceAll('needs.backend.outputs.mode', JSON.stringify(mode))
        .replaceAll(`needs.${child}.result`, JSON.stringify(childResult));
      expect(runInNewContext(expression, {}, { timeout: 100 })).toBe(expected);
    });
    it(`${name}: keeps secrets in the digest environment and has one D1 notifier`, () => {
      expect(job.environment).toBe('digest');
      expect(job.needs).toEqual(['backend', child]);
      expect(job['timeout-minutes']).toBe(5);
      expect(JSON.stringify(job)).not.toMatch(/TELEGRAM_|ANTHROPIC_|IMPORT_SERVICE_SECRET/);
      const calls = Object.values(workflow.jobs).flatMap((j: unknown) =>
        (j as { steps: { run?: string }[] }).steps.filter(s => s.run?.includes(`--notify ${name}`)));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.run).toContain('--stage "$FAILURE_STAGE"');
    });
  }
});

describe('safe operator notices', () => {
  const input = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123' };
  it('includes a validated run link and bounded stage, never free upstream text', () => {
    expect(noticeText('digest', 'backend', input)).toContain('https://github.com/owner/repo/actions/runs/123');
    expect(noticeText('canary', 'canary', input)).toContain('Etapa: canary.');
    expect(noticeText('digest', 'workflow', { ...input, GITHUB_SERVER_URL: 'https://private.example/secret' })).not.toContain('https://');
    expect(() => noticeText('digest', 'private upstream error', input)).toThrow();
  });
  it.each([false, true])('supports legacy and diagnostic Worker replies (diagnostics=%s)', async (diagnostics) => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const fetcher = vi.fn(async () => Response.json(diagnostics
        ? { sent: 0, failed: 1, failures: [{ category: 'authentication', httpStatus: 401, count: 1, description: 'private upstream' }], private: 'secret' }
        : { sent: 1, failed: 0 }, { headers: { 'cache-control': 'no-store' } }));
      const backend = httpBackend('https://example.test', 'a'.repeat(64), { fetch: fetcher });
      const call = notifyOperator(backend, 'digest', 'digest', input);
      if (diagnostics) await expect(call).rejects.toThrow('Notification failed');
      else await expect(call).resolves.toEqual({ sent: 1, failed: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const logs = JSON.stringify(print.mock.calls);
      expect(logs).not.toMatch(/private upstream|secret/);
      if (diagnostics) expect(logs).toContain('authentication');
    } finally { print.mockRestore(); }
  });
  it('does not retry an ambiguous response', async () => {
    const fetcher = vi.fn(async () => { throw new Error('transport failed'); });
    const backend = httpBackend('https://example.test', 'a'.repeat(64), { fetch: fetcher });
    await expect(notifyOperator(backend, 'digest', 'backend', input)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
