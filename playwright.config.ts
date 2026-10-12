import { defineConfig } from '@playwright/test';

// Real stack under test: fresh PostgreSQL database -> real seed CLI -> real API CLI (3000) -> real Vite dev server (5173).
// The admin URL comes from the environment only; it is never written to a committed file.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results/e2e-artifacts',
  fullyParallel: false,
  workers: 1, // all journeys share one demo database; each test resets business state first
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalTeardown: './tests/e2e/support/global-teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge', // system Microsoft Edge; no browser download
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/support/serve-api.mjs',
      url: 'http://127.0.0.1:3000/api/v1/health/ready',
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
