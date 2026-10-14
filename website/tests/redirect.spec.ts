/**
 * /working-groups/ lands on Contribute's working groups (site redesign spec §1.4, #454), with the
 * old section fragments mapped to the new group cards; without JavaScript the meta refresh does it.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

for (const [from, to] of [
  ['/working-groups/', '/contribute/#working-groups'],
  ['/working-groups/#data', '/contribute/#group-data'],
  ['/working-groups/#modeling', '/contribute/#group-modeling'],
  ['/working-groups/#ui', '/contribute/#group-ui'],
  ['/working-groups/#elsewhere', '/contribute/#working-groups'],
] as const)
  test(`${from} lands on ${to}`, async ({ page }) => {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to.replace(/[/#]/g, '\\$&')}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Find work that fits how you think.',
    );
  });

test.describe('without JavaScript @desktop-chromium', () => {
  test.use({ javaScriptEnabled: false });

  test('the meta refresh still lands on the working groups', async ({
    page,
  }) => {
    await page.goto('/working-groups/');
    await expect(page).toHaveURL(/\/contribute\/#working-groups$/);
  });
});
