/**
 * Privacy page browser checks (site redesign #454). Owned by the Privacy task; tests/analytics.spec.ts
 * keeps the disclosure pins.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

test('the privacy page opens on its heading', async ({ page }) => {
  await page.goto('/privacy/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    "What we measure, and what we don't.",
  );
});
