import { readFileSync } from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

import { atlasDataTarget } from './tests/support/atlas-data-target';
import {
  atlasDataServerArgs,
  playwrightPort,
} from './tests/setup/playwright-env';

delete process.env.NO_COLOR;
process.env.NO_UPDATE_NOTIFIER = '1';

const port = playwrightPort();
const baseURL = `http://127.0.0.1:${port}`;
const target = atlasDataTarget(
  readFileSync(new URL('./dist/app/index.html', import.meta.url), 'utf8'),
  process.env.ATLAS_DATA_DIR,
);

export default defineConfig({
  testDir: './tests',
  testMatch: /atlas-(performance|cold-load)\.spec\.ts/,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  retries: 0,
  workers: 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
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
    ...(target.kind === 'local'
      ? [
          {
            // The ATLAS_DATA_DIR staging tree on the build's data origin, served like the
            // bucket; a site port outside the CORS document gets --allow-origin, as in
            // playwright.config.ts (#411).
            command: [
              'node scripts/serve-atlas-data.mjs --root',
              JSON.stringify(target.directory),
              ...atlasDataServerArgs(baseURL),
            ].join(' '),
            url: `${target.base}catalog.json`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
});
