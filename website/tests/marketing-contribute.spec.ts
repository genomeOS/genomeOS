/**
 * Contribute page browser checks (moved from site.spec.ts, #454). Owned by the Contribute task.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

// Task 3 enables: the working groups now live on Contribute (spec §4.3 C2).
test.skip('the working groups link each group to issue work', async ({
  page,
}) => {
  await page.goto('/contribute/');
  await expect(
    page.getByRole('link', { name: 'Browse matching issues' }),
  ).toHaveCount(3);
  await expect(page.getByText('Group forming')).toHaveCount(3);
});
