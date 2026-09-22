import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env extends LocalEnv {
      VOTES: KVNamespace;
      MIGRATION_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      DIGEST_SERVICE_SECRET: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The current plugin isolates storage per file, not per test. Explicit reset uses FK order.
beforeEach(async () => {
  await env.DB.batch([
    ...['vote_reconciliations', 'import_blocks', 'import_sessions', 'operation_assertions', 'operation_lock', 'delivery_resolutions', 'votes', 'delivery_messages', 'user_articles', 'digest_items', 'digest_chunks',
      'digest_runs', 'data_imports', 'destinations', 'profile_sources', 'profile_versions', 'users', 'articles']
      .map(table => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("UPDATE system_controls SET mode='legacy' WHERE singleton=1"),
  ]);
});
