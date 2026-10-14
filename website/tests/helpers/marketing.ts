/**
 * The fixture hooks every page-level Playwright suite shares (moved verbatim from site.spec.ts for
 * the site redesign's per-page specs, #454): the Atlas browser fixture before each test, and no
 * route left behind after it.
 */
import { test } from '@playwright/test';

import { installAtlasBrowserFixture } from '../atlas-browser-fixture';

export function useSiteFixtures(): void {
  test.beforeEach(async ({ page }) => installAtlasBrowserFixture(page));
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
}
