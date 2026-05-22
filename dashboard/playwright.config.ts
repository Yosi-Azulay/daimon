import { defineConfig, devices } from '@playwright/test';

// E2E drive for the daimon dashboard (M64). Expects a daimon daemon already
// running and serving the SPA. Defaults to http://127.0.0.1:4999, override
// with DAIMON_BASE_URL.

const baseURL = process.env.DAIMON_BASE_URL || 'http://127.0.0.1:4999';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
