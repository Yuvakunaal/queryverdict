import { defineConfig, devices } from '@playwright/test';

// Production artifact (dist/, port 4173) and test-only harness artifact (dist-harness/, port 4174).
// Locally, Chromium tests use the installed Google Chrome; CI installs Playwright's Chromium.
const onCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: onCI,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173/queryverdict/' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...(onCI ? {} : { channel: 'chrome' }) } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: 'http://127.0.0.1:4173/queryverdict/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run build:harness && npm run preview:harness',
      url: 'http://127.0.0.1:4174/queryverdict/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
