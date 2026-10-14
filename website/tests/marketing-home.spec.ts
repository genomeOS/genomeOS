/**
 * Home page browser checks (moved verbatim from site.spec.ts, #454). Owned by the Home task, which
 * rewrites them for the new Home (spec §9.1).
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

test('reduced-motion preferences disable decorative hero movement', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const animationName = await page
    .locator('.hero__image')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animationName).toBe('none');

  // The header still compacts, at once: no transition to animate it.
  const header = page.locator('.site-header');
  await expect(header).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.site-header__inner')).toHaveCSS(
    'transition-duration',
    '0s',
  );
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(header).toHaveClass(/site-header--compact/);
  const box = (await header.boundingBox())!;
  expect(Math.abs(box.y)).toBeLessThanOrEqual(1);
  expect(box.height).toBeCloseTo(71.2, 0);
});

test('public typography keeps body and supporting text comfortably large', async ({
  page,
}) => {
  await page.goto('/');

  const typeSizes = await page.evaluate(() => {
    const selectors = [
      'body',
      '.desktop-nav a',
      '.section-kicker',
      '.site-footer p',
      '.mission-copy p',
    ];
    return Object.fromEntries(
      selectors.map((selector) => [
        selector,
        Number.parseFloat(
          getComputedStyle(document.querySelector(selector)!).fontSize,
        ),
      ]),
    );
  });

  expect(typeSizes.body).toBeGreaterThanOrEqual(19);
  for (const [selector, size] of Object.entries(typeSizes)) {
    if (selector !== 'body') expect(size).toBeGreaterThanOrEqual(16);
  }
});

test('metric digits use a common height and baseline', async ({ page }) => {
  await page.goto('/');

  const numericStyle = await page
    .locator('.metric data')
    .first()
    .evaluate((element) => ({
      family: getComputedStyle(element).fontFamily,
      variant: getComputedStyle(element).fontVariantNumeric,
    }));
  expect(numericStyle.family).toContain('Figtree');
  expect(numericStyle.variant).toContain('lining-nums');
  expect(numericStyle.variant).toContain('tabular-nums');
});

test('application cards reveal on scroll and respond to hover', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover movement is a pointer interaction');
  await page.goto('/');

  const card = page.locator('.application-card').first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/is-visible/);
  const restingTransform = await card.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await card.hover();
  await page.waitForTimeout(250);
  const hoverTransform = await card.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  expect(hoverTransform).not.toBe(restingTransform);
});
