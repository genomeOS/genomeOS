/**
 * Contribute page browser checks (moved from site.spec.ts, #454). Owned by the Contribute orbit and
 * flow task (round 2 plan T4).
 *
 * Contribute absorbs the Working groups page (site redesign spec §4.3). Round 2 (spec §4.3): the
 * orbit scene opens the page (its own file, marketing-contribute-orbit.spec.ts), the transit line
 * follows in its own section and lights a lane from that lane's own label. The work board has its
 * own file, marketing-contribute-board.spec.ts.
 */
import { expect, test } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const TRANSIT = '[data-graphic="transit-line"]';
const ORBIT = '[data-graphic="orbit"]';

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
  const { headerBottom, top, bottom, plateTop } = await heading.evaluate(
    (element, orbit) => ({
      headerBottom: document
        .querySelector('[data-site-header]')!
        .getBoundingClientRect().bottom,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      plateTop: document.querySelector(orbit)!.getBoundingClientRect().top,
    }),
    ORBIT,
  );
  expect(top).toBeGreaterThanOrEqual(headerBottom - 0.5);
  expect(bottom).toBeLessThanOrEqual(page.viewportSize()!.height);
  // The plate's top, not the section's, meets the compact bar's bottom edge (final verification:
  // the plate stopped at 151 px on a laptop and 128 px on a phone, with the intro's last line
  // showing between it and the bar).
  expect(Math.abs(plateTop - headerBottom)).toBeLessThan(1.5);
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
  test(`the orbit scene opens above the fold at ${width}×${height} ${tag}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/contribute/');
    const top = await page
      .locator(ORBIT)
      .evaluate((figure) => figure.getBoundingClientRect().top);
    expect(top).toBeLessThan(fold);
    // It is the page's first figure, so nothing opens on an empty half.
    expect(
      await page.evaluate(() =>
        document
          .querySelector('main figure[data-graphic]')
          ?.getAttribute('data-graphic'),
      ),
    ).toBe('orbit');
  });

test('the flow follows the orbit in its own section, and plays once', async ({
  page,
}) => {
  await page.goto('/contribute/');
  const flow = page.locator('#flow');
  await expect(
    flow.getByRole('heading', {
      level: 2,
      name: 'How the groups fit together.',
    }),
  ).toBeVisible();
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('main section[id]')].map(
      (section) => section.id,
    ),
  );
  expect(order.indexOf('flow')).toBe(order.indexOf('working-groups') + 1);
  // Below the fold now: it waits armed, then plays when scrolled to and rests.
  const figure = page.locator(TRANSIT);
  await expect(figure).toHaveAttribute('data-figure-state', 'armed');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 8_000,
  });
});

test('a lane label lights its own lane on the transit line', async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const figure = page.locator(TRANSIT);
  await figure.scrollIntoViewIfNeeded();
  for (const lane of ['data', 'modeling', 'ui']) {
    const hit = figure.locator(`[data-lane-button="${lane}"]:visible`).first();
    if (isMobile) await hit.tap();
    else await hit.hover();
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
  if (isMobile) {
    // A second tap on the pinned lane lets it go.
    await figure.locator('[data-lane-button="ui"]:visible').first().tap();
    await expect(figure).not.toHaveAttribute('data-active');
  } else {
    await page.mouse.move(2, 2);
    await expect(figure).not.toHaveAttribute('data-active');
  }
});

test('the lanes light from the keyboard too: focus shows one, Enter pins it', async ({
  page,
}) => {
  // Spec §4.3.3 "hover, focus, tap" (review of T4, finding 3): each lane label is a real button
  // over the drawing, in the tab order right after the orbit's links.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const figure = page.locator(TRANSIT);
  const lane = (name: string) => page.getByRole('button', { name });
  await page
    .locator('#group-ui')
    .getByRole('link', { name: 'Browse matching issues' })
    .focus();
  await page.keyboard.press('Tab');
  await expect(lane('Data & Infrastructure')).toBeFocused();
  await expect(figure).toHaveAttribute('data-active', 'data');
  await expect(lane('Data & Infrastructure')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('Enter');
  await expect(lane('Data & Infrastructure')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Tab');
  await expect(lane('Statistical & AI Modeling')).toBeFocused();
  await expect(figure).toHaveAttribute('data-active', 'modeling');
  await page.keyboard.press('Tab');
  await expect(lane('UI & Applications')).toBeFocused();
  await expect(figure).toHaveAttribute('data-active', 'ui');
  // Leaving the lanes, the pinned one stays lit; Space on it lets it go.
  await page.keyboard.press('Tab');
  await expect(figure).toHaveAttribute('data-active', 'data');
  await lane('Data & Infrastructure').focus();
  await page.keyboard.press('Space');
  await expect(lane('Data & Infrastructure')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(figure).not.toHaveAttribute('data-active');
  // The lanes are one labelled group, and no tab stop sits inside the drawing.
  await expect(
    page.getByRole('group', { name: 'Light a group’s lane on the line' }),
  ).toBeVisible();
  expect(
    await figure.evaluate(
      (element) =>
        element.querySelectorAll(
          'svg a, svg [tabindex], svg button, svg [focusable="true"]',
        ).length,
    ),
  ).toBe(0);
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
