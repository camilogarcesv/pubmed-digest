// Public diagnostics are fixed labels only, never provider messages, SQL, paths or identifiers.
const stages = ['prepare', 'inventory', 'legacy_check', 'schema_precheck', 'checkpoint',
  'bundle', 'migrate', 'schema_postcheck', 'drift_check', 'secrets_prepare', 'publish',
  'activation_check', 'bindings_check', 'propagation', 'smoke', 'schema_final_check', 'rollback'] as const;
const codes = ['step_failed', 'provider_command_failed', 'sql_incomplete_input', 'provider_access_denied'] as const;
const recoveries = ['not_attempted', 'previous_retained', 'previous_restored', 'manual_reconciliation'] as const;
export type ReleaseStage = typeof stages[number];
type ReleaseCode = typeof codes[number];
type Recovery = typeof recoveries[number];

export class ReleaseFailure extends Error {
  constructor(readonly stage: ReleaseStage, readonly code: ReleaseCode, readonly recovery: Recovery = 'not_attempted') {
    super(`Worker release failed: ${stage}/${code}; recovery=${recovery}`);
  }
}

export class ProviderFailure extends Error {
  constructor(readonly code: ReleaseCode) { super(code); }
}

export function commandFailure(error: unknown): ProviderFailure {
  // Inspect captured output in memory only. Unknown failures never echo even a substring.
  const output = error && typeof error === 'object'
    ? ['stdout', 'stderr'].map(key => {
      const value = (error as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : '';
    }).join('\n') : '';
  return new ProviderFailure(/incomplete input:\s*SQLITE_ERROR/.test(output)
    ? 'sql_incomplete_input' : 'provider_command_failed');
}

export function releaseFailure(stage: ReleaseStage, error: unknown, recovery: Recovery = 'not_attempted'): ReleaseFailure {
  return new ReleaseFailure(stage, error instanceof ProviderFailure ? error.code : 'step_failed', recovery);
}

export function formatReleaseFailure(error: unknown): string {
  // Runtime allowlists also protect against accidentally passing untrusted labels.
  const valid = error instanceof ReleaseFailure && stages.includes(error.stage)
    && codes.includes(error.code) && recoveries.includes(error.recovery);
  return JSON.stringify(valid
    ? { event: 'worker_release_failed', stage: error.stage, code: error.code, recovery: error.recovery }
    : { event: 'worker_release_failed', stage: 'unknown', code: 'step_failed', recovery: 'manual_reconciliation' });
}
