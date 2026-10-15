/**
 * Contribute's "How work moves" in the browser (site redesign spec §4.3 C2; round 2 spec §4.3.4;
 * #454): one example issue moves through the board with exactly one tab, one column and one
 * definition line agreeing at every moment. Owned by the board task (round 2 plan T5); split
 * verbatim out of marketing-contribute.spec.ts (plan T0 step 3).
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

// Board polish (design review, round 1): the card keeps clear of its column's frame, the reply
// mark clears the station's name and the idea card, and each label chip carries its own colon.
test('the board’s card, reply mark and label chips never collide @desktop-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/contribute/');
  const board = page.locator(BOARD);
  await board.scrollIntoViewIfNeeded();
  const tabs = board.getByRole('tab');
  for (let index = 0; index < 5; index += 1) {
    await tabs.nth(index).click();
    const gap = await board.evaluate((figure) => {
      const card = [...figure.querySelectorAll<HTMLElement>('.wb-card')].find(
        (element) => !element.hidden,
      )!;
      const place = figure.querySelector('.wb-place.is-here')!;
      return (
        place.getBoundingClientRect().bottom -
        card.getBoundingClientRect().bottom
      );
    });
    expect(gap, `step ${index + 1}`).toBeGreaterThanOrEqual(6);
  }
  await tabs.nth(0).click();
  const overlaps = await board.evaluate((figure) => {
    const box = (element: Element) => element.getBoundingClientRect();
    const reply = box(figure.querySelector('.wb-station__reply')!);
    const name = box(
      figure.querySelector('.wb-station__head > span:last-child')!,
    );
    const card = box(figure.querySelector('.wb-card[data-at="discussion"]')!);
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom;
    return { name: hit(reply, name), card: hit(reply, card) };
  });
  expect(overlaps).toEqual({ name: false, card: false });
  // Panel 4 reads "wants-expert-review build it…": no colon hanging off the chip's border.
  await tabs.nth(3).click();
  const after = await page
    .locator('#wb-panel-4 .wb-label')
    .evaluateAll((labels) =>
      labels.map((label) => {
        let node = label.nextSibling;
        while (
          node &&
          node.nodeType === Node.ELEMENT_NODE &&
          (node as Element).classList.contains('visually-hidden')
        )
          node = node.nextSibling;
        return (node?.textContent ?? '').trimStart().charAt(0);
      }),
    );
  expect(after).toHaveLength(2);
  for (const first of after) expect(first).not.toBe(':');
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
