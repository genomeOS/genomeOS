/**
 * Contribute page browser checks (moved from site.spec.ts, #454). Owned by the Contribute task.
 *
 * Contribute absorbs the Working groups page (site redesign spec §4.3): the transit line opens the
 * page, the group cards light their lanes on it, and one example issue moves through the board
 * with exactly one tab, one column and one definition line agreeing at every moment.
 */
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const BOARD = '[data-graphic="work-board"]';
const TRANSIT = '[data-graphic="transit-line"]';
const PLACES = ['discussion', 'backlog', 'ready', 'in-progress', 'in-review'];

/** What the board shows: the selected tab, the card's place, the lit column and the line. */
const boardState = (page: Page) =>
  page.evaluate((selector) => {
    const figure = document.querySelector(selector)!;
    const selected = [
      ...figure.querySelectorAll('[role="tab"][aria-selected="true"]'),
    ];
    const shownCards = [
      ...figure.querySelectorAll<HTMLElement>('.wb-card'),
    ].filter(
      (card) => !card.hidden && getComputedStyle(card).visibility === 'visible',
    );
    const lit = [...figure.querySelectorAll<HTMLElement>('.wb-place.is-here')];
    const definitions = [
      ...figure.querySelectorAll<HTMLElement>('[data-definition]'),
    ].filter((line) => !line.hidden);
    const panels = [
      ...document.querySelectorAll<HTMLElement>('.wb-panels [role="tabpanel"]'),
    ].filter((panel) => !panel.hidden);
    // What marks the card's place sits inside the lit place's box, never across two: the card
    // itself on a wide board, its marker in the row on a narrow one (the card shows in a dock).
    const marker = lit[0]?.querySelector<HTMLElement>('.wb-marker');
    const mark =
      marker && marker.getBoundingClientRect().width > 0
        ? marker
        : shownCards[0];
    const box = mark.getBoundingClientRect();
    const place = lit[0]?.getBoundingClientRect();
    const inside =
      !!place &&
      box.left >= place.left - 1 &&
      box.right <= place.right + 1 &&
      box.top >= place.top - 1 &&
      box.bottom <= place.bottom + 1;
    return {
      selected: selected.map((tab) => tab.id),
      step: Number(figure.querySelector<HTMLElement>('.wb')!.dataset.step),
      cards: shownCards.length,
      at: shownCards[0]?.dataset.at,
      lit: lit.map((element) => element.dataset.place),
      definitions: definitions.map((line) => line.dataset.definition),
      panels: panels.map((panel) => panel.id),
      inside,
    };
  }, BOARD);

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

test('the board keeps one tab, one column and one line in step', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const board = page.locator(BOARD);
  await board.scrollIntoViewIfNeeded();
  // Reduced motion: no tour; the first step is selected.
  let state = await boardState(page);
  expect(state.selected).toEqual(['wb-tab-1']);
  expect(state.at).toBe('discussion');
  expect(state.definitions).toEqual([]);
  const tabs = board.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    await tabs.nth(index).click();
    state = await boardState(page);
    expect(state.selected).toEqual([`wb-tab-${index + 1}`]);
    expect(state.step).toBe(index + 1);
    expect(state.cards).toBe(1);
    expect(state.at).toBe(PLACES[index]);
    expect(state.lit).toEqual([PLACES[index]]);
    expect(state.definitions).toEqual(index === 0 ? [] : [PLACES[index]]);
    expect(state.panels).toEqual([`wb-panel-${index + 1}`]);
    expect(state.inside, `step ${index + 1}`).toBe(true);
  }
  // Arrow keys move the selection, as in every tablist.
  await tabs.nth(4).press('ArrowLeft');
  await expect(tabs.nth(3)).toBeFocused();
  expect((await boardState(page)).at).toBe('in-progress');
});

test('the board tours once, agreeing at every moment, and rests on step 5', async ({
  page,
}) => {
  await page.goto('/contribute/');
  const board = page.locator(BOARD);
  await board.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  const seen = new Set<number>();
  for (let elapsed = 0; elapsed < 7_000; elapsed += 150) {
    const state = await boardState(page);
    expect(state.selected).toHaveLength(1);
    expect(state.selected[0]).toBe(`wb-tab-${state.step}`);
    expect(state.cards).toBe(1);
    expect(state.at).toBe(PLACES[state.step - 1]);
    expect(state.lit).toEqual([state.at]);
    expect(state.panels).toEqual([`wb-panel-${state.step}`]);
    seen.add(state.step);
    await page.waitForTimeout(150);
  }
  expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  const rest = await boardState(page);
  expect(rest.step).toBe(5);
  expect(rest.inside).toBe(true);
  await expect(board).toHaveAttribute('data-figure-state', 'rest');
});

test('choosing a step stops the tour where the visitor chose', async ({
  page,
}) => {
  await page.goto('/contribute/');
  const board = page.locator(BOARD);
  await board.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(board).toHaveAttribute('data-figure-state', 'playing');
  await board.getByRole('tab', { name: /Read the record/ }).click();
  await expect(board).toHaveAttribute('data-figure-state', 'rest');
  await page.waitForTimeout(6_500);
  const state = await boardState(page);
  expect(state.step).toBe(2);
  expect(state.at).toBe('backlog');
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the five steps are an ordered list and the board shows Ready', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const steps = page.locator('.wb-panels > li');
    await expect(steps).toHaveCount(5);
    for (let index = 0; index < 5; index += 1)
      await expect(steps.nth(index)).toBeVisible();
    await expect(page.locator(`${BOARD} [role="tablist"]`)).toBeHidden();
    const state = await boardState(page);
    expect(state.at).toBe('ready');
    expect(state.lit).toEqual(['ready']);
    expect(state.definitions).toEqual(['ready']);
    // The transit line and the vignettes show their final state.
    await expect(
      page.locator(`${TRANSIT} [data-token="hex"]`).first(),
    ).toBeAttached();
  });
});
