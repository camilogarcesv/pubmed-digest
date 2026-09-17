import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './worker/local/wrangler.jsonc' },
    remoteBindings: false,
    miniflare: { kvNamespaces: ['VOTES'], d1Databases: ['DB', 'MIGRATION_DB'], bindings: {
      TEST_MIGRATIONS: await readD1Migrations('./worker/migrations'),
      DIGEST_SERVICE_SECRET: 'synthetic-test-secret-only',
    } },
  }))],
  test: {
    include: ['worker/tests/**/*.test.ts'],
    setupFiles: ['./worker/tests/setup.ts'],
    fileParallelism: false,
  },
});
