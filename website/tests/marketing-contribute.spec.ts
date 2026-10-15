/**
 * Contribute page browser checks (moved from site.spec.ts, #454). Owned by the Contribute task.
 *
 * Contribute absorbs the Working groups page (site redesign spec §4.3): the transit line opens the
 * page and the group cards light their lanes on it. The work board has its own file,
 * marketing-contribute-board.spec.ts (round 2 plan T0 step 3).
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const TRANSIT = '[data-graphic="transit-line"]';

test('the working groups link each group to issue work', async ({ page }) => {
  await page.goto('/contribute/');
  await expect(
    page.getByRole('link', { name: 'Browse matching issues' }),
  ).toHaveCount(3);
  await expect(page.getByText('Group forming')).toHaveCount(3);
});

test('/working-groups/ shows "Three groups are forming." below the fixed header', async ({
  page,
}) => {
  await page.goto('/working-groups/');
  await expect(page).toHaveURL(/\/contribute\/#working-groups$/);
  const heading = page.getByRole('heading', {
    level: 2,
    name: 'Three groups are forming.',
  });
  await expect(heading).toBeInViewport();
  // html's smooth scrolling and the bar's 200 ms resize settle first.
  await page.waitForTimeout(1_000);
  const { headerBottom, top, bottom } = await heading.evaluate((element) => ({
    headerBottom: document
      .querySelector('[data-site-header]')!
      .getBoundingClientRect().bottom,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
  }));
  expect(top).toBeGreaterThanOrEqual(headerBottom - 0.5);
  expect(bottom).toBeLessThanOrEqual(page.viewportSize()!.height);
});

// Design review, round 2: four cards broke 3 + 1 from 960 to 1279 px, leaving an orphan. They sit
// 2 × 2 until one row of four fits (80rem), as on Home's closing band.
test('Start here sets its four cards 2 × 2 until one row of four fits @desktop-chromium', async ({
  page,
}) => {
  for (const width of [700, 960, 1024, 1180, 1200, 1279, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/contribute/');
    const boxes = await page
      .locator('#start .github-cta')
      .evaluateAll((links) =>
        links.map((link) => link.getBoundingClientRect().toJSON()),
      );
    expect(boxes, `${width}`).toHaveLength(4);
    const rows = new Map<number, number>();
    for (const box of boxes)
      rows.set(Math.round(box.top), (rows.get(Math.round(box.top)) ?? 0) + 1);
    expect([...rows.values()], `${width} px`).toEqual(
      width >= 1280 ? [4] : [2, 2],
    );
  }
});

for (const [tag, width, height, fold] of [
  ['@desktop-chromium', 1440, 900, 640],
  ['@mobile-chromium', 390, 844, 700],
] as const)
  test(`the transit line opens above the fold at ${width}×${height} ${tag}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/contribute/');
    const top = await page
      .locator(TRANSIT)
      .evaluate((figure) => figure.getBoundingClientRect().top);
    expect(top).toBeLessThan(fold);
    // It is the page's first figure, so nothing opens on an empty half.
    expect(
      await page.evaluate(() =>
        document
          .querySelector('main figure[data-graphic]')
          ?.getAttribute('data-graphic'),
      ),
    ).toBe('transit-line');
  });

declare global {
  interface Window {
    __transitPaints?: { state: string | null; drawn: boolean }[];
  }
}

// Spec §2.7 rule 5: above the fold never flashes. The line is server-rendered fully drawn; with
// motion allowed it must arm before its first paint, never draw, undraw and redraw (design
// review, round 1).
test('the transit line never paints drawn and then undraws for its entrance', async ({
  page,
  isMobile,
}) => {
  // Where the line plays at load: 200 px of it in the first view (1440×900; a Pixel 7).
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const paints: NonNullable<Window['__transitPaints']> = [];
    window.__transitPaints = paints;
    const sample = () => {
      const figure = document.querySelector('[data-graphic="transit-line"]');
      const line = [
        ...(figure?.querySelectorAll<SVGPathElement>('.wg-line--lit') ?? []),
      ].find((path) => path.getClientRects().length > 0);
      if (figure && line) {
        const style = getComputedStyle(line);
        paints.push({
          state: figure.getAttribute('data-figure-state'),
          drawn:
            style.strokeDasharray === 'none' ||
            Number.parseFloat(style.strokeDashoffset) < 0.02,
        });
      }
      if (performance.now() < 5000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/contribute/');
  await expect(page.locator(TRANSIT)).toHaveAttribute(
    'data-figure-state',
    'rest',
    { timeout: 8_000 },
  );
  await page.waitForTimeout(200);
  const paints = await page.evaluate(() => window.__transitPaints ?? []);
  expect(paints.length).toBeGreaterThan(5);
  const drawn = paints.findIndex((paint) => paint.drawn);
  expect(drawn).toBeGreaterThanOrEqual(0);
  // Once the whole line has painted, it stays drawn.
  expect(paints.slice(drawn).every((paint) => paint.drawn)).toBe(true);
});

test('a group card lights its own lane on the transit line', async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const figure = page.locator(TRANSIT);
  for (const lane of ['data', 'modeling', 'ui']) {
    const card = page.locator(`[data-wg-card="${lane}"]`);
    if (isMobile) await card.locator('h3').tap();
    else await card.hover();
    await expect(figure).toHaveAttribute('data-active', lane);
    // Only art dims: every label in the figure keeps its full opacity.
    const dimmedText = await figure.evaluate((element) =>
      [...element.querySelectorAll('svg text')]
        .filter((text) => text.getClientRects().length > 0)
        .filter((text) => {
          let node: Element | null = text;
          while (node && node !== element) {
            if (Number(getComputedStyle(node).opacity) < 1) return true;
            node = node.parentElement;
          }
          return false;
        })
        .map((text) => text.textContent),
    );
    expect(dimmedText, lane).toEqual([]);
  }
  if (!isMobile) {
    await page.mouse.move(2, 2);
    await expect(figure).not.toHaveAttribute('data-active');
  }
  // Keyboard: the card's only tab stop, its issue link, lights the lane too.
  await page
    .locator('[data-wg-card="modeling"]')
    .getByRole('link', { name: 'Browse matching issues' })
    .focus();
  await expect(figure).toHaveAttribute('data-active', 'modeling');
});

test('both tokens reach the map: the hex joins the stud, never replaces it', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const tokens = await page.locator(TRANSIT).evaluate((figure) => {
    const svg = [...figure.querySelectorAll('svg')].find(
      (item) => item.getClientRects().length > 0,
    )!;
    const centre = (selector: string) => {
      const box = svg.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    return {
      stud: centre('[data-token="stud"]'),
      hex: centre('[data-token="hex"]'),
      map: centre('[data-station="map"] circle'),
      service: centre('[data-station="service"] circle'),
    };
  });
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  // Two separate marks, side by side, closer to the map than to the data service.
  expect(distance(tokens.stud, tokens.hex)).toBeGreaterThan(8);
  for (const token of [tokens.stud, tokens.hex])
    expect(distance(token, tokens.map)).toBeLessThan(
      distance(token, tokens.service),
    );
});
