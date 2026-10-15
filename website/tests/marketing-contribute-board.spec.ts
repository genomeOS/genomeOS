/**
 * Contribute's "How work moves" in the browser (round 2 spec §4.3.4, §8, §11.2; R2-7, R2-8; #454):
 * GitHub's board in its dark UI with the astronaut story, scrubbed through window.__motion (the
 * e2e build) at the spec's seek table, never on wall-clock sleeps except where the point is real
 * time (the 35% start, an offscreen pause). Owned by the board task (round 2 plan T5).
 *
 * BOARD_SHOTS=<dir> also saves the board at every seek for the visual review.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const BOARD = '[data-graphic="work-board"]';
const SHOTS = process.env.BOARD_SHOTS;

async function openBoard(page: Page) {
  await page.goto('/contribute/');
  await page
    .locator(BOARD)
    .evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
  await page.evaluate(() => window.__motion!.ready('board'));
}

const seek = (page: Page, ms: number) =>
  page.evaluate((t) => window.__motion!.seek('board', t), ms);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page
    .locator(BOARD)
    .screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'allow' });
}

/** What the board shows at this instant. */
const boardState = (page: Page) =>
  page.evaluate((selector) => {
    const figure = document.querySelector<HTMLElement>(selector)!;
    const opacity = (element: Element | null) =>
      element ? Number(getComputedStyle(element).opacity) : NaN;
    const live = figure.querySelector('.floor-svg--live');
    const bubbles = Object.fromEntries(
      [...(live?.querySelectorAll('.say') ?? [])].map((bubble) => [
        bubble.textContent ?? '',
        Math.round(opacity(bubble) * 100) / 100,
      ]),
    );
    const columns = [...figure.querySelectorAll<HTMLElement>('[data-col]')];
    const columnAt = (x: number) =>
      columns.findIndex((column) => {
        const box = column.getBoundingClientRect();
        return x >= box.left && x <= box.right;
      });
    const card = figure
      .querySelector('[data-example="home"]')!
      .getBoundingClientRect();
    const counts = columns.map((column) => {
      const shown = [
        ...column.querySelectorAll<HTMLElement>('.gh-count > span'),
      ].filter((number) => !number.hidden && opacity(number) > 0.5);
      return shown.length === 1 ? Number(shown[0].textContent) : NaN;
    });
    const status = [
      ...figure.querySelectorAll<HTMLElement>('[data-example="home"] .st'),
    ]
      .filter((word) => !word.hidden && opacity(word) > 0.5)
      .map((word) => word.textContent!.trim());
    const cells = [...(live?.querySelectorAll('.wall-cell') ?? [])];
    const lit = cells.filter(
      (cell) => getComputedStyle(cell).fill !== 'rgb(42, 74, 116)',
    ).length;
    /** Which column each astronaut stands in (by its helmet). */
    const where = Object.fromEntries(
      ['A2', 'A3', 'A5', 'E1', 'E2'].map((id) => {
        const helmet = live?.querySelector(
          `.who-${id} circle[fill="url(#wb-kHelm)"]`,
        );
        const box = helmet?.getBoundingClientRect();
        return [id, box ? columnAt(box.left + box.width / 2) : -2];
      }),
    );
    return {
      bubbles,
      card: columnAt(card.left + card.width / 2),
      counts,
      status,
      lit,
      cells: cells.length,
      socket: opacity(live?.querySelector('.wall-fill') ?? null),
      where,
      glow: getComputedStyle(figure.querySelector('[data-example="home"]')!)
        .borderTopColor,
      avatar: opacity(figure.querySelector('[data-example="home"] .ex-av')),
      bulb: opacity(live?.querySelector('.bulb') ?? null),
      spark: opacity(live?.querySelector('.strike-spark') ?? null),
      held: {
        A3: opacity(live?.querySelector('.who-A3 .held-vis') ?? null),
        E1: opacity(live?.querySelector('.who-E1 .held-vis') ?? null),
      },
      state: figure.dataset.sceneState,
    };
  }, BOARD);

/**
 * How crowded the floor is at this instant: whether each astronaut's face is on top at its helmet's
 * centre (nobody stands in front of it), how far each helmet sits inside its column's borders, how
 * many of the wall's cells no astronaut covers (of how many), and whether the pull request's row
 * fits its card.
 */
const crowding = (page: Page, which = '.floor-svg--live') =>
  page.evaluate(
    ([selector, floorSvg]) => {
      const figure = document.querySelector<HTMLElement>(selector)!;
      const floor = figure.querySelector<HTMLElement>('.gh-floor')!;
      const svg = floor.querySelector(floorSvg)!;
      const columns = [...figure.querySelectorAll('[data-col]')].map((column) =>
        column.getBoundingClientRect(),
      );
      // The floor ignores the pointer; let it be hit-tested for the measurement only.
      floor.style.pointerEvents = 'auto';
      const top = (x: number, y: number) =>
        document
          .elementsFromPoint(x, y)
          .find((element) => svg.contains(element));
      // Every astronaut drawn (the live cast, or each appearance in the storyboard).
      const faces = [...svg.querySelectorAll('.astro')].map((astro) => {
        const helmet = astro
          .querySelector('circle[fill="url(#wb-kHelm)"]')!
          .getBoundingClientRect();
        const x = helmet.left + helmet.width / 2;
        const column = columns.find((box) => x >= box.left && x <= box.right);
        const hit = top(x, helmet.top + helmet.height / 2);
        return {
          id: astro.getAttribute('data-cast')!,
          shows: !!hit && astro.contains(hit),
          inside: column
            ? Math.round(
                Math.min(
                  helmet.left - column.left,
                  column.right - helmet.right,
                ),
              )
            : -999,
        };
      });
      const cells = [...svg.querySelectorAll('.wall-cell')];
      const wall = cells.filter((cell) => {
        const box = cell.getBoundingClientRect();
        const hit = top(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && !hit.closest('.astro');
      }).length;
      floor.style.pointerEvents = '';
      const row = figure.querySelector<HTMLElement>(
        '[data-example="home"] .ex-pr',
      )!;
      return {
        faces,
        wall,
        cells: cells.length,
        rowFits: row.scrollWidth <= row.clientWidth,
      };
    },
    [BOARD, which] as const,
  );

/** Only the named bubble shows (opacity 1); every other is hidden. */
function onlyBubble(bubbles: Record<string, number>, text: string | null) {
  for (const [said, value] of Object.entries(bubbles))
    expect(value, said).toBe(said === text ? 1 : 0);
}

/**
 * Every speech bubble showing in the floor at this instant: its words, and how far its body sits
 * inside the column its tail points into, at the tighter side (px; negative when it crosses the
 * column's border).
 */
const bubblesShown = (page: Page, which = '.floor-svg--live') =>
  page.evaluate(
    ([selector, floorSvg]) => {
      const figure = document.querySelector<HTMLElement>(selector)!;
      const svg = figure.querySelector(floorSvg)!;
      const columns = [...figure.querySelectorAll('[data-col]')].map((column) =>
        column.getBoundingClientRect(),
      );
      return [...svg.querySelectorAll<SVGGElement>('.bubble')]
        .filter((bubble) =>
          bubble.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }),
        )
        .map((bubble) => {
          const body = bubble.querySelector<SVGPathElement>('path')!;
          const [, tx, ty] = /L(-?[\d.]+) (-?[\d.]+)/.exec(
            body.getAttribute('d')!,
          )!;
          const tip = new DOMPoint(Number(tx), Number(ty)).matrixTransform(
            body.getScreenCTM()!,
          );
          const box = body.getBoundingClientRect();
          const column = columns.find(
            (edges) => tip.x >= edges.left && tip.x <= edges.right,
          );
          return {
            text: bubble.textContent!.replace(/\s+/g, ' ').trim(),
            inside: column
              ? Math.round(
                  Math.min(box.left - column.left, column.right - box.right),
                )
              : -999,
          };
        });
    },
    [BOARD, which] as const,
  );

/** The speech bubbles, each at an instant it fully shows: [key, speaker, ms]. */
const SAYS: [string, string, number][] = [
  ['hello', 'A3', 3000],
  ['welcome', 'A2', 3950],
  ['backlog', 'A5', 5050],
  ['q', 'E1', 22205],
  ['a', 'A3', 23505],
  ['checks', 'E2', 24730],
  ['ok', 'E1', 25880],
];

/** How far a live bubble's tail tip is from its speaker's helmet top (px). */
const tailGap = (page: Page, key: string, who: string) =>
  page.evaluate(
    ([selector, k, id]) => {
      const svg = document.querySelector<SVGSVGElement>(
        `${selector} .floor-svg--live`,
      )!;
      const point = (element: SVGGraphicsElement, x: number, y: number) =>
        new DOMPoint(x, y).matrixTransform(element.getScreenCTM()!);
      const tail = svg.querySelector<SVGPathElement>(`.say-${k} path`)!;
      const [, tx, ty] = /L(-?[\d.]+) (-?[\d.]+)/.exec(
        tail.getAttribute('d')!,
      )!;
      const tip = point(tail, Number(tx), Number(ty));
      const helmet = svg.querySelector<SVGCircleElement>(
        `.who-${id} circle[fill="url(#wb-kHelm)"]`,
      )!;
      const top = point(
        helmet,
        helmet.cx.baseVal.value,
        helmet.cy.baseVal.value - helmet.r.baseVal.value,
      );
      return Math.hypot(tip.x - top.x, tip.y - top.y);
    },
    [BOARD, key, who] as const,
  );

const LIT_BLUE = 'rgb(31, 111, 235)';

test.describe('the story at the seek table @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('every beat shows what the storyboard says, column by column', async ({
    page,
  }) => {
    await openBoard(page);

    // 2.45 s, Discussion: three newcomers have hopped in; "Hi! I'd like to help." pops.
    await seek(page, 2450);
    let s = await boardState(page);
    expect(s.where).toMatchObject({ A2: 0, A3: 0, A5: 0, E1: 4, E2: 4 });
    expect(s.card).toBe(1);
    expect(s.counts).toEqual([1, 2, 1, 1, 1]);
    expect(s.lit).toBe(0);
    expect(s.socket).toBe(0);
    await seek(page, 2450 + 300);
    onlyBubble((await boardState(page)).bubbles, 'Hi! I’d like to help.');
    await shot(page, 'seek-02450');

    // 10.04 s, Backlog: the idea, then the pick: the card lights and takes the avatar (Ready).
    await seek(page, 10040);
    s = await boardState(page);
    expect(s.where.A3).toBe(1);
    expect(s.bulb).toBe(1);
    expect(s.card).toBe(1);
    await seek(page, 10040 + 600);
    s = await boardState(page);
    expect(s.glow).toBe(LIT_BLUE);
    expect(s.avatar).toBe(1);
    await shot(page, 'seek-10040');

    // 13.62 s, In progress: the first strike; the card came along.
    await seek(page, 13620);
    s = await boardState(page);
    expect(s.where.A3).toBe(2);
    expect(s.spark).toBe(1);
    expect(s.card).toBe(2);
    expect(s.counts).toEqual([1, 1, 2, 1, 1]);
    onlyBubble(s.bubbles, null);
    await shot(page, 'seek-13620');

    // 21.58 s, In review: the experts have walked over; "Where are the counts from?"
    await seek(page, 21580 + 300);
    s = await boardState(page);
    expect(s.where).toMatchObject({ A3: 3, E1: 3, E2: 3 });
    expect(s.card).toBe(3);
    expect(s.counts).toEqual([1, 1, 1, 2, 1]);
    expect(s.status).toEqual(['Review requested']);
    onlyBubble(s.bubbles, 'Where are the counts from?');
    await shot(page, 'seek-21580');

    // 25.43 s: "Approved!", and the pull request says so.
    await seek(page, 25430);
    expect((await boardState(page)).status).toEqual(['Review requested']);
    await seek(page, 25430 + 300);
    s = await boardState(page);
    expect(s.status).toEqual(['Approved']);
    onlyBubble(s.bubbles, 'Approved!');
    await shot(page, 'seek-25430');

    // 28.09 s: the hand-off: the block passes from the contributor to the expert at one point.
    await seek(page, 28090 - 50);
    s = await boardState(page);
    expect(s.held).toEqual({ A3: 1, E1: 1 });
    await seek(page, 28090 + 300);
    s = await boardState(page);
    expect(s.held).toEqual({ A3: 0, E1: 1 });
    expect(s.card).toBe(3);
    await shot(page, 'seek-28090');

    // 30.71 s, Merge: the block fits the socket; the card is merged; the wall starts to light.
    await seek(page, 30710);
    s = await boardState(page);
    expect(s.where.E1).toBe(4);
    expect(s.card).toBe(4);
    expect(s.status).toEqual(['Merged']);
    expect(s.counts).toEqual([1, 1, 1, 1, 2]);
    expect(s.socket).toBe(0);
    await seek(page, 30710 + 400);
    s = await boardState(page);
    expect(s.socket).toBe(1);
    expect(s.lit).toBeGreaterThan(0);
    expect(s.lit).toBeLessThan(s.cells);
    await shot(page, 'seek-30710');

    // 36 s, the story's end: the wall complete and shining, everyone where the story left them.
    await seek(page, 36000);
    s = await boardState(page);
    expect(s.where).toMatchObject({ A2: 0, A5: 0, A3: 4, E1: 4, E2: 4 });
    expect(s.cells).toBe(11);
    expect(s.lit).toBe(11);
    expect(s.socket).toBe(1);
    expect(s.card).toBe(4);
    expect(s.status).toEqual(['Merged']);
    expect(s.counts).toEqual([1, 1, 1, 1, 2]);
    expect(s.glow).not.toBe(LIT_BLUE);
    onlyBubble(s.bubbles, null);
    await shot(page, 'seek-36000');
  });

  test('every speech bubble’s tail points at its speaker’s helmet', async ({
    page,
  }) => {
    await openBoard(page);
    // Floor units are CSS px on the desktop board (the floor's viewBox is its own size).
    for (const [key, who, mid] of SAYS) {
      await seek(page, mid);
      expect(
        await tailGap(page, key, who),
        `${key} (${who}) at ${mid} ms`,
      ).toBeLessThanOrEqual(6);
    }
  });

  test('the story starts at 35% visible, pauses off screen, and obeys Pause and Replay', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const board = page.locator(BOARD);
    // A sliver in view: the scene is built (it loads one viewport early) but has not started.
    await board.evaluate((figure) => {
      const top = figure.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top - innerHeight + 90, behavior: 'instant' });
    });
    await page.evaluate(() => window.__motion!.ready('board'));
    await page.waitForTimeout(600);
    await expect(board).toHaveAttribute('data-scene-state', 'armed');
    expect(await page.evaluate(() => window.__motion!.time('board'))).toBe(0);

    await board.evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(board).toHaveAttribute('data-scene-state', 'playing');
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => window.__motion!.time('board')),
    ).toBeGreaterThan(200);

    // Off screen, every animation in the board pauses.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(board).toHaveAttribute('data-scene-state', 'paused');
    // The scene's own tracks (a hovered button's CSS transition is not the scene).
    const running = () =>
      page.evaluate(
        (selector) =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                !(animation instanceof CSSTransition) &&
                (
                  (animation.effect as KeyframeEffect).target as Element
                )?.closest(selector),
            ).length,
        BOARD,
      );
    expect(await running()).toBe(0);

    // Back on screen it resumes; the visitor's Pause holds until Play.
    await board.evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(board).toHaveAttribute('data-scene-state', 'playing');
    const toggle = board.getByRole('button', {
      name: 'Pause the board animation',
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(board).toHaveAttribute('data-scene-state', 'paused');
    expect(await running()).toBe(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await running()).toBeGreaterThan(0);

    // Replay starts the story over.
    await seek(page, 20000);
    await board
      .getByRole('button', { name: 'Replay the board animation' })
      .click();
    await expect(board).toHaveAttribute('data-scene-state', 'playing');
    expect(
      await page.evaluate(() => window.__motion!.time('board')),
    ).toBeLessThan(2000);
  });

  test('a resize keeps the clock’s time and refits the floor', async ({
    page,
  }) => {
    await openBoard(page);
    await seek(page, 21580 + 300);
    const before = await page.evaluate(() => window.__motion!.time('board'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(() =>
        page
          .locator(`${BOARD} .floor-svg--live`)
          .evaluate((svg) => Number(svg.getAttribute('width'))),
      )
      .toBeLessThan(1300);
    // The refit redraws the floor, then puts the new tracks back at the same instant.
    await expect.poll(async () => (await boardState(page)).where.A3).toBe(3);
    expect(await page.evaluate(() => window.__motion!.time('board'))).toBe(
      before,
    );
    const s = await boardState(page);
    expect(s.where).toMatchObject({ A3: 3, E1: 3, E2: 3 });
    expect(s.card).toBe(3);
    onlyBubble(s.bubbles, 'Where are the counts from?');
  });
});

// From the narrowest desktop (64rem, iPad landscape: 177 px columns) to 1440, the story keeps the
// same composition: every face shows, nobody crosses a column's border, the finished wall shines
// whole through the celebration, the end and the idle loop (design critique 4: the experts stood in
// front of it and hid half of it), and the pull request's status word is never clipped.
for (const width of [1024, 1100, 1152, 1280, 1440]) {
  test.describe(`the floor at ${width} px @desktop-chromium`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('keeps every face in view, every helmet inside its column and every word whole', async ({
      page,
    }) => {
      await openBoard(page);
      // Discussion, the pick, a strike, the question, Approved, the hand-off, the fit, the
      // celebration, the end, and the idle loop (the contributor's hop, the expert's nod).
      for (const t of [
        2750, 10640, 13620, 21880, 25730, 28390, 31110, 33400, 34500, 36000,
        39300, 41000,
      ]) {
        await seek(page, t);
        const c = await crowding(page);
        expect(c.faces).toHaveLength(5);
        for (const { id, shows, inside } of c.faces) {
          expect(shows, `${id}'s face shows at ${t} ms`).toBe(true);
          expect(
            inside,
            `${id}'s helmet inside its column at ${t} ms`,
          ).toBeGreaterThanOrEqual(0);
        }
        expect(c.rowFits, `the pull request row fits at ${t} ms`).toBe(true);
        if (t >= 33400)
          expect(c.wall, `wall cells in view at ${t} ms`).toBe(c.cells);
      }
    });

    // Review of T5 round 3: a bubble scales from its tail with an overshoot, so an edge far from
    // the tail swung 9–13 px past In review's borders for about 100 ms at 1,152 and 1,280 px.
    // Every 10 ms through each bubble's pop, read from its own story track, no bubble crosses.
    test('keeps every speech bubble inside its speaker’s column while it pops', async ({
      page,
    }) => {
      await openBoard(page);
      const pops = await page.evaluate((selector) => {
        const svg = document.querySelector(`${selector} .floor-svg--live`)!;
        return [...svg.querySelectorAll('.bubble-pop')].flatMap((pop) =>
          pop.getAnimations().flatMap((animation): [number, number][] => {
            const effect = animation.effect as KeyframeEffect;
            if (effect.getTiming().iterations !== 1) return [];
            const length = Number(effect.getComputedTiming().duration);
            const frames = effect.getKeyframes();
            const at = frames.findIndex(
              (frame, index) =>
                frame.transform === 'scale(0)' &&
                frames[index + 1]?.transform === 'scale(1)',
            );
            return at < 0
              ? []
              : [
                  [
                    Number(frames[at].computedOffset) * length,
                    Number(frames[at + 1].computedOffset) * length,
                  ],
                ];
          }),
        );
      }, BOARD);
      expect(pops.length).toBeGreaterThanOrEqual(SAYS.length);
      const crossings = await page.evaluate(
        async ([selector, windows]) => {
          const figure = document.querySelector<HTMLElement>(selector)!;
          const svg = figure.querySelector('.floor-svg--live')!;
          const columns = [...figure.querySelectorAll('[data-col]')].map(
            (column) => column.getBoundingClientRect(),
          );
          const found: string[] = [];
          for (const [from, to] of windows)
            for (let t = Math.floor(from); t <= to + 10; t += 10) {
              await window.__motion!.seek('board', t);
              for (const bubble of svg.querySelectorAll<SVGGElement>(
                '.bubble',
              )) {
                if (
                  !bubble.checkVisibility({
                    opacityProperty: true,
                    visibilityProperty: true,
                  })
                )
                  continue;
                const body = bubble.querySelector<SVGPathElement>('path')!;
                const [, tx, ty] = /L(-?[\d.]+) (-?[\d.]+)/.exec(
                  body.getAttribute('d')!,
                )!;
                const tip = new DOMPoint(
                  Number(tx),
                  Number(ty),
                ).matrixTransform(body.getScreenCTM()!);
                const box = body.getBoundingClientRect();
                const column = columns.find(
                  (edges) => tip.x >= edges.left && tip.x <= edges.right,
                );
                const inside = column
                  ? Math.min(box.left - column.left, column.right - box.right)
                  : -999;
                if (inside < 0)
                  found.push(
                    `“${bubble.textContent!.replace(/\s+/g, ' ').trim()}” ${inside.toFixed(1)} px at ${t} ms`,
                  );
              }
            }
          return found;
        },
        [BOARD, pops] as const,
      );
      expect(crossings).toEqual([]);
    });

    test('keeps every speech bubble inside its speaker’s column, its tail on the helmet', async ({
      page,
    }) => {
      await openBoard(page);
      for (const [key, who, mid] of SAYS) {
        await seek(page, mid);
        const shown = await bubblesShown(page);
        expect(shown, `${key} at ${mid} ms`).toHaveLength(1);
        expect(
          shown[0].inside,
          `“${shown[0].text}” inside its column`,
        ).toBeGreaterThanOrEqual(4);
        expect(
          await tailGap(page, key, who),
          `${key} (${who}) tail at ${mid} ms`,
        ).toBeLessThanOrEqual(6);
      }
    });
  });
}

test.describe('the example card @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('closes its pull-request row entirely until review, like the cards beside it', async ({
    page,
  }) => {
    await openBoard(page);
    // A card's padding under its labels: the example card in Backlog and #63 beside it.
    const tail = (card: string) =>
      page.locator(`${BOARD} ${card}`).evaluate((article) => {
        const labels = article
          .querySelector('.gh-card__labels')!
          .getBoundingClientRect();
        return Math.round(
          article.getBoundingClientRect().bottom - labels.bottom,
        );
      });
    for (const t of [10640, 13620]) {
      await seek(page, t);
      expect(await tail('[data-example="home"]')).toBe(
        await tail('[data-col="backlog"] .gh-card:not(.gh-card--example)'),
      );
    }
    // In review its row is open.
    await seek(page, 21880);
    expect(await tail('[data-example="home"]')).toBeGreaterThan(30);
  });

  test('opens its pull-request row without shifting anything on the board', async ({
    page,
  }) => {
    await openBoard(page);
    await seek(page, 18000);
    await page.evaluate((selector) => {
      const board = document.querySelector(selector)!;
      const w = window as unknown as { boardShift: number };
      w.boardShift = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as {
          value: number;
          sources: { node?: Node }[];
        }[])
          if (entry.sources.some((source) => board.contains(source.node!)))
            w.boardShift += entry.value;
      }).observe({ type: 'layout-shift' });
    }, BOARD);
    // The card arrives in In review and its row opens (about 18.6–19.1 s), frame by frame.
    for (let t = 18400; t <= 19400; t += 40) {
      await seek(page, t);
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
    }
    const shift = await page.evaluate(
      () => (window as unknown as { boardShift: number }).boardShift,
    );
    expect(shift).toBeLessThan(0.0001);
  });

  test('says each column’s count once to assistive tech', async ({ page }) => {
    await openBoard(page);
    await seek(page, 13620);
    const counts = page.locator(`${BOARD} .gh-count`);
    await expect(counts).toHaveCount(5);
    for (const count of await counts.all())
      await expect(count).toHaveAttribute('aria-hidden', 'true');
  });
});

test.describe('the phone camera @mobile-chromium', () => {
  /** The column centred in the board's window, and the pressed column button. */
  const camera = (page: Page) =>
    page.evaluate((selector) => {
      const figure = document.querySelector(selector)!;
      const view = figure.querySelector('.gh-scroll')!.getBoundingClientRect();
      const centre = view.left + view.width / 2;
      const columns = [...figure.querySelectorAll('[data-col]')].map(
        (column) => {
          const box = column.getBoundingClientRect();
          return Math.abs(box.left + box.width / 2 - centre);
        },
      );
      const pressed = [
        ...figure.querySelectorAll('.wb-colnav button[aria-pressed="true"]'),
      ].map((button) => button.textContent!.trim());
      return {
        column: columns.indexOf(Math.min(...columns)),
        pressed,
      };
    }, BOARD);

  test('follows the action to each beat, and the column buttons say where it is', async ({
    page,
  }) => {
    await openBoard(page);
    const names = [
      'Discussion',
      'Backlog',
      'In progress',
      'In review',
      'Merge',
    ];
    const table: [number, number][] = [
      [2450, 0],
      [10040, 1],
      [13620, 2],
      [21580, 3],
      [25430, 3],
      [28090, 3],
      [30710, 4],
      [36000, 4],
    ];
    await expect(page.locator(`${BOARD} .wb-colnav`)).toBeVisible();
    for (const [t, column] of table) {
      await seek(page, t);
      await expect
        .poll(() => camera(page))
        .toEqual({
          column,
          pressed: [names[column]],
        });
      await shot(page, `phone-seek-${String(t).padStart(5, '0')}`);
    }
  });

  test('a column button pauses the scene and pans to its column', async ({
    page,
  }) => {
    await openBoard(page);
    await seek(page, 36000);
    await page
      .locator(BOARD)
      .getByRole('button', { name: 'Pause the board animation' })
      .click();
    await page
      .locator(`${BOARD} .wb-colnav`)
      .getByRole('button', { name: 'Backlog' })
      .click();
    await expect
      .poll(() => camera(page))
      .toEqual({ column: 1, pressed: ['Backlog'] });
    await expect(
      page
        .locator(BOARD)
        .getByRole('button', { name: 'Pause the board animation' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // Play hands the view back to the camera.
    await page
      .locator(BOARD)
      .getByRole('button', { name: 'Pause the board animation' })
      .click();
    await expect
      .poll(() => camera(page))
      .toEqual({ column: 4, pressed: ['Merge'] });
  });
});

test.describe('the phone track at 320 px @mobile-chromium', () => {
  test.use({ viewport: { width: 320, height: 740 } });

  /** How far the column sits inside the board's window, at its tighter side (px). */
  const margin = (page: Page, key: string) =>
    page.locator(BOARD).evaluate((figure, column) => {
      const view = figure.querySelector('.gh-scroll')!.getBoundingClientRect();
      const box = figure
        .querySelector(`[data-col="${column}"]`)!
        .getBoundingClientRect();
      return Math.round(Math.min(box.left - view.left, view.right - box.right));
    }, key);

  test('the camera shows its whole column, borders and all, with its cast inside', async ({
    page,
  }) => {
    await openBoard(page);
    for (const [t, key, cast] of [
      [2750, 'discussion', ['A2', 'A3', 'A5']],
      [21880, 'review', ['A3', 'E2', 'E1']],
      [36000, 'merge', ['A3', 'E2', 'E1']],
    ] as const) {
      await seek(page, t);
      await expect.poll(() => margin(page, key)).toBeGreaterThanOrEqual(0);
      const { faces, wall, cells } = await crowding(page);
      for (const id of cast)
        expect(
          faces.find((face) => face.id === id)!.inside,
          `${id} at ${t} ms`,
        ).toBeGreaterThanOrEqual(0);
      // At the end the finished wall shines whole beside the crew (design critique 4).
      if (key === 'merge')
        expect(wall, `wall cells in view at ${t} ms`).toBe(cells);
    }
  });

  // Design critique 4: "Discussion" filled its button from border to border at 320 px.
  test('every column button keeps its words inside, with room either side, at 13 px or more', async ({
    page,
  }) => {
    await openBoard(page);
    const buttons = await page
      .locator(`${BOARD} .wb-colnav button`)
      .evaluateAll((all) =>
        all.map((button) => {
          const box = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const lines = [...range.getClientRects()];
          const size = parseFloat(getComputedStyle(button).fontSize);
          return {
            name: button.textContent!.trim(),
            size,
            // The room between the words and the border, at the tighter side, in em.
            room:
              Math.min(
                ...lines.map((line) =>
                  Math.min(line.left - box.left, box.right - line.right),
                ),
              ) / size,
          };
        }),
      );
    expect(buttons.map(({ name }) => name)).toEqual([
      'Discussion',
      'Backlog',
      'In progress',
      'In review',
      'Merge',
    ]);
    for (const { name, size, room } of buttons) {
      expect(size, name).toBeGreaterThanOrEqual(13);
      expect(room, name).toBeGreaterThanOrEqual(0.3);
    }
  });

  test('under reduced motion each column scrolls fully into the window', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/contribute/');
    const board = page.locator(BOARD);
    await board.evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect.poll(() => margin(page, 'merge')).toBeGreaterThanOrEqual(0);
    await board
      .locator('.wb-colnav')
      .getByRole('button', { name: 'In review' })
      .click();
    await expect.poll(() => margin(page, 'review')).toBeGreaterThanOrEqual(0);
  });
});

test.describe('reduced motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('shows the storyboard, builds nothing, and keeps every word', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const board = page.locator(BOARD);
    await board.evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(800);
    await expect(board.locator('.floor-svg--sb')).toBeVisible();
    await expect(board.locator('.floor-svg--live')).toHaveCount(0);
    expect(
      await page.evaluate(
        (selector) =>
          document
            .getAnimations()
            .filter((animation) =>
              ((animation.effect as KeyframeEffect).target as Element)?.closest(
                selector,
              ),
            ).length,
        BOARD,
      ),
    ).toBe(0);
    await expect(board.locator('[data-scene-toggle]')).toBeHidden();
    await expect(board.locator('[data-scene-replay]')).toBeHidden();
    // Every word, in the bubbles the storyboard shows (the hello is drawn on one line and on
    // two; the stylesheet shows the one that fits).
    await expect(
      board.locator('.floor-svg--sb text').filter({ visible: true }),
    ).toHaveText(['Hi! I’d like to help.', 'Approved!']);
    const s = await boardState(page);
    expect(s.counts).toEqual([1, 1, 1, 1, 2]);
    expect(s.status).toEqual(['Merged']);
    await shot(page, 'reduced');
  });

  for (const width of [1024, 1100, 1152, 1280, 1440])
    test(`at ${width} px the storyboard keeps every face in view and inside its column @desktop-chromium`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/contribute/');
      await page
        .locator(BOARD)
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      const c = await crowding(page, '.floor-svg--sb');
      // A3 once per column; the newcomers; the experts in review and at the wall.
      expect(c.faces).toHaveLength(11);
      for (const { id, shows, inside } of c.faces) {
        expect(shows, `${id}'s face shows`).toBe(true);
        expect(
          inside,
          `${id}'s helmet inside its column`,
        ).toBeGreaterThanOrEqual(0);
      }
      // The crew celebrates beside the wall, never in front of it.
      expect(c.cells, 'wall cells').toBe(11);
      expect(c.wall, 'wall cells in view').toBe(c.cells);
      expect(c.rowFits).toBe(true);
      // Both bubbles, whole and inside their speaker's column.
      const shown = await bubblesShown(page, '.floor-svg--sb');
      expect(shown.map(({ text }) => text)).toEqual([
        'Hi! I’d like to help.',
        'Approved!',
      ]);
      for (const { text, inside } of shown)
        expect(inside, `“${text}” inside its column`).toBeGreaterThanOrEqual(4);
    });

  test('on a phone the track scrolls natively and the column buttons scroll it @mobile-chromium', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const board = page.locator(BOARD);
    await board.evaluate((figure) =>
      figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    const scroller = board.locator('.gh-scroll');
    await expect(scroller).toHaveCSS('overflow-x', 'auto');
    const nav = board.locator('.wb-colnav');
    await expect(nav).toBeVisible();
    // It rests on Merge, where the story ends.
    await expect(nav.getByRole('button', { name: 'Merge' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await nav.getByRole('button', { name: 'Backlog' }).click();
    await expect(nav.getByRole('button', { name: 'Backlog' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(() =>
        board.evaluate((figure) => {
          const view = figure
            .querySelector('.gh-scroll')!
            .getBoundingClientRect();
          const column = figure
            .querySelector('[data-col="backlog"]')!
            .getBoundingClientRect();
          return Math.abs(
            column.left + column.width / 2 - (view.left + view.width / 2),
          );
        }),
      )
      .toBeLessThan(2);
    await shot(page, 'phone-reduced');
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the storyboard and the cards show; the controls stay hidden', async ({
    page,
  }) => {
    await page.goto('/contribute/');
    const board = page.locator(BOARD);
    await board.scrollIntoViewIfNeeded();
    await expect(board.locator('.floor-svg--sb')).toBeVisible();
    await expect(board.locator('[data-col]')).toHaveCount(5);
    await expect(board.locator('[data-example="home"]')).toContainText(
      'Merged',
    );
    await expect(board.locator('[data-scene-toggle]')).toBeHidden();
    await expect(board.locator('.wb-colnav')).toBeHidden();
  });
});

/* ------------------------------------- below 64rem, the track by keyboard and to axe (WCAG 2.1.1) */

/** Serious or critical axe violations in How work moves, with the site's tags (site.spec.ts). */
async function boardAxe(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('#how-work-moves')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter(({ impact }) => ['serious', 'critical'].includes(impact ?? ''))
    .map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map(({ target }) => target.join(' ')).join(' | ')}`,
    );
}

const scrollLeft = (page: Page) =>
  page
    .locator(`${BOARD} .gh-scroll`)
    .evaluate((scroller) => Math.round(scroller.scrollLeft));

/**
 * Wherever the track scrolls by hand, it is a named region a keyboard reaches, shows focus on and
 * scrolls with the arrow keys, column by column.
 */
async function keyboardScrolls(page: Page) {
  const scroller = page.locator(`${BOARD} .gh-scroll`);
  await expect(scroller).toHaveAttribute('tabindex', '0');
  await expect(scroller).toHaveAttribute('role', 'region');
  await expect(scroller).toHaveAccessibleName('Board, scrolls sideways');
  // Reached by Tab (back from the next stop), as a keyboard does.
  await scroller.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(scroller).toBeFocused();
  await expect(scroller).not.toHaveCSS('outline-style', 'none');
  const before = await scrollLeft(page);
  if (before > 0) {
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => scrollLeft(page)).toBeLessThan(before);
  } else {
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before);
  }
}

const attributes = (page: Page) =>
  page.locator(`${BOARD} .gh-scroll`).evaluate((scroller) => ({
    tabindex: scroller.getAttribute('tabindex'),
    role: scroller.getAttribute('role'),
    label: scroller.getAttribute('aria-label'),
  }));

test.describe('the phone and tablet track by keyboard @mobile-chromium', () => {
  for (const width of [390, 900])
    test(`under reduced motion at ${width} px a keyboard scrolls the columns, and axe finds nothing serious`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 840 });
      await page.goto('/contribute/');
      await page
        .locator(BOARD)
        .evaluate((figure) =>
          figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
        );
      // It rests on Merge, where the story ends.
      await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0);
      await keyboardScrolls(page);
      expect(await boardAxe(page)).toEqual([]);
    });

  test('before the scene arrives a keyboard scrolls the columns, and axe finds nothing serious', async ({
    page,
  }) => {
    // The board's lazy scene never arrives: the server's track stands.
    await page.route(/\/_astro\/board\.[^/]*\.js$/, (route) => route.abort());
    await page.goto('/contribute/');
    // As loaded, the board below the fold (the plain load site.spec.ts checks).
    expect(await boardAxe(page)).toEqual([]);
    await page
      .locator(BOARD)
      .evaluate((figure) =>
        figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
    await page.waitForTimeout(500);
    await expect(page.locator(`${BOARD} .floor-svg--live`)).toHaveCount(0);
    await keyboardScrolls(page);
    expect(await boardAxe(page)).toEqual([]);
  });

  test('once the scene drives the camera the track is a plain box, and the column buttons take over', async ({
    page,
  }) => {
    await openBoard(page);
    expect(await attributes(page)).toEqual({
      tabindex: null,
      role: null,
      label: null,
    });
    await expect(page.locator(`${BOARD} .wb-colnav`)).toBeVisible();
    expect(await boardAxe(page)).toEqual([]);
  });
});

test.describe('the phone and tablet track without JavaScript @mobile-chromium', () => {
  test.use({ javaScriptEnabled: false });

  for (const width of [390, 900])
    test(`at ${width} px a keyboard scrolls the columns`, async ({ page }) => {
      await page.setViewportSize({ width, height: 840 });
      await page.goto('/contribute/');
      await page.locator(BOARD).scrollIntoViewIfNeeded();
      await expect(page.locator(`${BOARD} .wb-colnav`)).toBeHidden();
      await keyboardScrolls(page);
    });
});

// axe runs as a script, so here the page is served without its own scripts instead.
test.describe('the phone and tablet track with the page’s scripts removed @mobile-chromium', () => {
  for (const width of [390, 900])
    test(`at ${width} px axe finds nothing serious`, async ({ page }) => {
      await page.route('**/contribute/', async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /<script\b[\s\S]*?<\/script>/g,
          '',
        );
        await route.fulfill({ response, body });
      });
      await page.setViewportSize({ width, height: 840 });
      await page.goto('/contribute/');
      await page.locator(BOARD).scrollIntoViewIfNeeded();
      await expect(page.locator(`${BOARD} .wb-colnav`)).toBeHidden();
      await expect(page.locator(`${BOARD} .gh-scroll`)).toHaveAttribute(
        'tabindex',
        '0',
      );
      expect(await boardAxe(page)).toEqual([]);
    });
});

test.describe('the desktop board @desktop-chromium', () => {
  test('shows every column, so its track is no tab stop, with or without the scene', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBoard(page);
    expect(await attributes(page)).toEqual({
      tabindex: null,
      role: null,
      label: null,
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/contribute/');
    await page
      .locator(BOARD)
      .evaluate((figure) =>
        figure.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
    await expect
      .poll(() => attributes(page))
      .toEqual({
        tabindex: null,
        role: null,
        label: null,
      });
  });
});
