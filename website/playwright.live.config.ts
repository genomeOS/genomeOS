/**
 * The live browser SQL gate (Atlas data platform design 2026-10-18 §11 step 1.13; F6): the pinned
 * DuckDB-WASM against the public data store, from the e2e build's hook. Never run in CI; the owner
 * runs it once the bucket's CORS change is applied:
 *
 *   cd website && BROWSER_SQL_LIVE=1 npx playwright test --config playwright.live.config.ts
 *
 * It builds the e2e site first, so it needs no other step.
 */
import { defineConfig, devices } from '@playwright/test';

import { playwrightPort } from './tests/setup/playwright-env';

delete process.env.NO_COLOR;
process.env.NO_UPDATE_NOTIFIER = '1';

const port = playwrightPort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser-sql-live.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: { baseURL, timezoneId: 'UTC', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build:e2e && npm run serve:test',
    env: { PLAYWRIGHT_PORT: String(port) },
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
