/**
 * Project page browser checks (moved verbatim from site.spec.ts, #454). Owned by the Project task,
 * which rewrites them for the new Project page (spec §9.1).
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

test('project page labels all three capability states', async ({ page }) => {
  await page.goto('/project/');
  await expect(
    page.getByRole('heading', { name: 'Available now' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'In active development' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Future exploration' }),
  ).toBeVisible();
});

test('multi-scale illustrations load with accessible descriptions', async ({
  page,
}) => {
  await page.goto('/project/');
  const images = page.locator('.vision-card img');
  await expect(images).toHaveCount(3);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveJSProperty('complete', true);
    expect(await image.getAttribute('alt')).not.toBe('');
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBe(1536);
  }
});
