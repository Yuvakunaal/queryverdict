import { defineConfig } from '@playwright/test';

// Uses the locally installed Google Chrome (no browser download). Safari and Firefox are
// covered manually; see README.md.
// Two servers: the PRODUCTION artifact (dist/, port 4173) and the TEST-ONLY harness artifact
// (dist-harness/, port 4174) with negative controls and fault injection.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:4173/queryverdict/', channel: 'chrome', headless: true },
  webServer: [
    {
      command: 'node scripts/vendor-extensions.mjs && npx vite build && npx vite preview --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173/queryverdict/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx vite build --config vite.harness.config.ts && npx vite preview --config vite.harness.config.ts --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174/queryverdict/harness/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
