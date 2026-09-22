import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { resetDatabase } from './fixtures.js';

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
beforeEach(resetDatabase);
