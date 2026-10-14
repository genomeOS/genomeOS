/**
 * 404 page browser checks (moved from site.spec.ts with the "Docs" label, #454). Owned by the 404
 * task.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

test('404 page offers three recovery routes', async ({ page }) => {
  await page.goto('/404.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'That route is outside the atlas.',
  );
  const recovery = page.locator('main');
  await expect(recovery.getByRole('link', { name: /Home/ })).toBeVisible();
  await expect(
    recovery.getByRole('link', { name: /Contribute/ }),
  ).toBeVisible();
  await expect(recovery.getByRole('link', { name: /Docs/ })).toBeVisible();
});
