/**
 * 404 page browser checks (site redesign spec §4.6, plan Task 6; #454). Owned by the 404 task.
 *
 * The page is the shared PageIntro in its split layout, whose figure is a static "No estimate"
 * cell: a seven-cell patch with a hatched centre under a crosshair, and a readout on the
 * crosshair's arm. Three cards lead back. The cross-page suites (word-budget, figures, motion,
 * copy-spacing) read the page's manifest, tests/pages/404.json.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const TITLE = 'That route is outside the atlas.';

const noEstimate = (page: Page) =>
  page.locator('main .page-intro__figure figure[data-graphic="no-estimate"]');

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  expect(found, 'the element is laid out').not.toBeNull();
  return found!;
};

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

test('an unknown address is answered with status 404 and this page', async ({
  page,
}) => {
  const response = await page.goto('/no-such-route/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE);
});

test('the routes back are three cards, to Home, Contribute and Docs', async ({
  page,
}) => {
  await page.goto('/404.html');
  const cards = page
    .getByRole('navigation', { name: 'Ways back' })
    .getByRole('link');
  await expect(cards).toHaveCount(4);
  expect(
    await cards.evaluateAll((links) =>
      links.map((link) => [
        link.getAttribute('href'),
        link.textContent?.replace(/\s+/g, ' ').trim(),
      ]),
    ),
  ).toEqual([
    ['/', 'Home Who we are, how it works.'],
    ['/projects/', 'Projects What we’re building.'],
    ['/contribute/', 'Contribute Find your group.'],
    ['/docs/', 'Docs Science and engineering.'],
  ]);
  await expect(cards.first()).toHaveAccessibleName(
    'Home Who we are, how it works.',
  );
});

// Design review, round 3: cards never leave one alone in a row. Four routes back (Projects joined
// them, design critique of the integrated build): one column, 2 × 2 from 38rem, then one row of four
// from 80rem, as the site's other rows of four.
test('the four routes back are one column, then 2 × 2, then one row, never 3 + 1 @desktop-chromium', async ({
  page,
}) => {
  for (const width of [390, 600, 608, 700, 900, 1000, 1279, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/404.html');
    const rows = await page
      .getByRole('navigation', { name: 'Ways back' })
      .getByRole('link')
      .evaluateAll((links) => {
        const tops = links.map((link) =>
          Math.round(link.getBoundingClientRect().top),
        );
        return [...new Set(tops)].map(
          (top) => tops.filter((other) => other === top).length,
        );
      });
    // An em in a media query is the 16 px initial size, so 38rem is 608 px and 80rem 1280 px.
    expect(rows, `${width} px`).toEqual(
      width >= 1280 ? [4] : width >= 608 ? [2, 2] : [1, 1, 1, 1],
    );
  }
});

test('the intro is the shared PageIntro, split, with the No estimate cell as its figure', async ({
  page,
}) => {
  await page.goto('/404.html');
  const main = page.locator('main');
  await expect(main.locator('.page-intro')).toHaveCount(1);
  await expect(main.locator('.page-intro--split .page-intro__note')).toHaveText(
    '404',
  );
  await expect(main.locator('.page-intro--split .page-intro__lede')).toHaveText(
    'No evidence here, and no page either.',
  );
  await expect(
    main.locator('.resource-links, .resource-links__grid'),
  ).toHaveCount(0);

  const figure = noEstimate(page);
  await expect(figure).toHaveCount(1);
  // Decorative (spec §4.6): the heading and the lede carry the meaning.
  await expect(figure).toHaveAttribute('aria-hidden', 'true');
  await expect(figure.locator(':scope > figcaption')).toHaveText(
    /^\s*No estimate\s*—\s*This address has no page\.\s*$/,
  );
  // No evidence, no number (spec §6.1.4): nothing in the figure is a figure.
  expect(await figure.textContent()).not.toMatch(/\d/);

  const drawing = await figure.evaluate((element) => {
    const svg = [
      ...element.querySelectorAll<SVGSVGElement>('svg[data-patch]'),
    ].find((candidate) => candidate.checkVisibility());
    if (!svg) return null;
    const centre = (target: Element | null) => {
      if (!target) return null;
      const { left, top, width, height } = target.getBoundingClientRect();
      return { x: left + width / 2, y: top + height / 2 };
    };
    const hatch = svg.querySelector('[data-hatch]');
    return {
      cells: svg.querySelectorAll('[data-cell]').length,
      unknown: svg.querySelectorAll('[data-cell="unknown"]').length,
      land: svg.querySelectorAll('[data-cell="land"]').length,
      hatchCoversUnknown:
        hatch !== null &&
        svg.querySelector('[data-cell="unknown"]')?.getAttribute('d') ===
          hatch.getAttribute('d'),
      unknownAt: centre(svg.querySelector('[data-cell="unknown"]')),
      crosshairAt: centre(svg.querySelector('[data-crosshair]')),
      patchAt: centre(svg.querySelector('[data-cells]')),
    };
  });
  expect(drawing, 'one patch is drawn').not.toBeNull();
  expect(drawing!.cells).toBe(7);
  expect(drawing!.unknown).toBe(1);
  expect(drawing!.land).toBe(6);
  expect(
    drawing!.hatchCoversUnknown,
    'the hatch lies on the unknown cell',
  ).toBe(true);
  // The hatched cell is the patch's centre, and the crosshair sits on it.
  for (const other of [drawing!.crosshairAt, drawing!.patchAt]) {
    expect(Math.abs(other!.x - drawing!.unknownAt!.x)).toBeLessThan(1);
    expect(Math.abs(other!.y - drawing!.unknownAt!.y)).toBeLessThan(1);
  }
});

test('the figure is static: no script state and nothing moving', async ({
  page,
}) => {
  await page.goto('/404.html');
  const figure = noEstimate(page);
  await expect(figure).not.toHaveAttribute('data-figure-state');
  expect(
    await figure.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});

test('the readout sits on the end of the crosshair arm at every width', async ({
  page,
}) => {
  await page.goto('/404.html');
  for (const width of [1440, 1024, 900, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const stage = await box(noEstimate(page).locator('[data-figure-stage]'));
    const readout = await box(noEstimate(page).locator(':scope > figcaption'));
    const cell = await box(
      noEstimate(page)
        .locator('svg[data-patch]:visible [data-cell="unknown"]')
        .first(),
    );
    const cellX = cell.x + cell.width / 2;
    const cellY = cell.y + cell.height / 2;
    const beside =
      Math.abs(readout.x - (stage.x + stage.width)) <= 1 &&
      readout.y < cellY &&
      readout.y + readout.height > cellY;
    const below =
      Math.abs(readout.y - (stage.y + stage.height)) <= 1 &&
      readout.x < cellX &&
      readout.x + readout.width > cellX;
    expect(beside || below, `${width} px: the readout meets an arm`).toBe(true);
  }
});

test('no sideways scroll at 320, 390, 640 or 1440 px', async ({ page }) => {
  for (const width of [320, 390, 640, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/404.html');
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width} px`).toBeLessThanOrEqual(0);
  }
});

for (const viewport of [
  { tag: '@desktop-chromium', width: 1440, height: 900 },
  { tag: '@mobile-chromium', width: 390, height: 844 },
] as const)
  test.describe(`at ${viewport.width} px ${viewport.tag}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('one h1 and no serious axe violations', async ({ page }) => {
      await page.goto('/404.html');
      await expect(page.locator('h1')).toHaveCount(1);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.filter(({ impact }) =>
          ['serious', 'critical'].includes(impact ?? ''),
        ),
      ).toEqual([]);
    });
  });

test.describe('on a wide screen @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the figure stands right of the heading, and every route is in the first view', async ({
    page,
  }) => {
    await page.goto('/404.html');
    const heading = await box(page.locator('main h1'));
    const lede = await box(page.locator('main .page-intro__lede'));
    const figure = await box(noEstimate(page));
    expect(figure.x).toBeGreaterThan(lede.x + lede.width);
    expect(figure.x).toBeGreaterThan(heading.x + 1440 / 3);
    expect(figure.y).toBeLessThan(lede.y + lede.height);
    for (const card of await page
      .getByRole('navigation', { name: 'Ways back' })
      .getByRole('link')
      .all()) {
      const { y, height } = await box(card);
      expect(y + height).toBeLessThan(900);
    }
  });
});

test.describe('on a phone @mobile-chromium', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the figure follows the lede inside the gutters, and the first route is in the first view', async ({
    page,
  }) => {
    await page.goto('/404.html');
    const lede = await box(page.locator('main .page-intro__lede'));
    const figure = await box(noEstimate(page));
    expect(figure.y).toBeGreaterThanOrEqual(lede.y + lede.height);
    expect(figure.x).toBeGreaterThanOrEqual(16);
    expect(figure.x + figure.width).toBeLessThanOrEqual(390 - 16);
    const first = await box(
      page
        .getByRole('navigation', { name: 'Ways back' })
        .getByRole('link')
        .first(),
    );
    expect(first.y + first.height).toBeLessThan(844);
  });
});
