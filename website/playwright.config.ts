import { defineConfig, devices } from '@playwright/test';

import {
  atlasDataServerArgs,
  playwrightPort,
  playwrightWorkers,
} from './tests/setup/playwright-env';

delete process.env.NO_COLOR;
process.env.NO_UPDATE_NOTIFIER = '1';

const port = playwrightPort();
const baseURL = `http://127.0.0.1:${port}`;
// The data server stays on 4323; a site port outside the CORS document's list is granted by the
// test-only --allow-origin (#411), so moving PLAYWRIGHT_PORT keeps the cross-origin specs working.
const dataServerArgs = atlasDataServerArgs(baseURL);

export default defineConfig({
  testDir: './tests',
  testMatch: /(site|atlas-mobile|atlas-cross-origin)\.spec\.ts/,
  fullyParallel: false,
  workers: playwrightWorkers(),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // CI renders the Cesium globe through software WebGL, where a full /app/ load
  // alone can take ~30 s; locally the default 30 s budget still applies.
  timeout: process.env.CI ? 90_000 : 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // A describe tagged with one project's name is filtered out of the other at
  // collection time. A runtime skip would still occupy a slot under --shard.
  projects: [
    {
      name: 'desktop-chromium',
      grepInvert: /@mobile-chromium\b/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      grepInvert: /@desktop-chromium\b/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      // package.json `serve:test` is the one definition of the test server; it reads the port.
      command: 'npm run serve:test',
      env: { PLAYWRIGHT_PORT: String(port) },
      url: `${baseURL}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The artifact base of the e2e build (design 2026-10-07 §C.3): the committed
      // fixture tree, served cross-origin with gzip and the bucket's CORS policy.
      command:
        dataServerArgs.length === 0
          ? 'npm run serve:atlas-data'
          : `npm run serve:atlas-data -- ${dataServerArgs.join(' ')}`,
      url: 'http://127.0.0.1:4323/catalog.json',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
