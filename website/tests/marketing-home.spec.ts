/**
 * Home page browser checks (round 2 spec §4.1, §11.2; R2-3, R2-7, rulings item 25; #454). Owned by
 * the Home task. The cross-page suites (word-budget, figures, motion) check what every page shares;
 * these check Home's own figures on the e2e build, scrubbed through the motion hooks
 * (`window.__motion`, round 2 spec §3.4):
 *
 *   people        100 people, 86 · 13 · 1 in that order, the ring and its leader ending at the note
 *   how-it-works  the storyboard at 700, 1600, 2600, 3400 and 4900 ms; the measured lane's studs
 *                 never pass through the model; Replay
 *   crew          the hop-in; each card fills "Your spot" while hovered or focused
 *
 * Screenshot comparisons need no stored baselines (they would differ by platform): a seek is
 * deterministic (the same frame twice), and every story ends on exactly the figure that reduced
 * motion and no JavaScript show. The frames are attached to the report, and taken with animations
 * allowed (Playwright's `animations: 'disabled'` would fast-forward a seeked, paused story to its
 * end). The hero film and the Atlas preview have their own file, marketing-home-hero.spec.ts.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

// window.__motion: declared in src/graphics/motion-hooks.ts; the e2e build ships it.

const VIEWPORT = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};
const viewportFor = (isMobile: boolean) =>
  isMobile ? VIEWPORT.phone : VIEWPORT.desktop;

const people = (page: Page) => page.locator('figure[data-graphic="people"]');
const steps = (page: Page) =>
  page.locator('figure[data-graphic="how-it-works"]');
const crew = (page: Page) => page.locator('figure[data-graphic="crew"]');

/** Bring a figure into view (its module loads within 600 px) and put its scene at `ms`. */
async function seek(figure: Locator, scene: string, ms: number): Promise<void> {
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await figure
    .page()
    .evaluate(([name, at]) => window.__motion!.seek(name, at), [
      scene,
      ms,
    ] as const);
}

/** The layout of a figure that is on screen (each figure renders two, one displayed). */
const shown = (figure: Locator, selector: string) =>
  figure.locator(`${selector}:visible`).first();

/**
 * The share of 4 × 4 CSS-pixel blocks whose average colour differs between two screenshots of the
 * same size (any channel by more than 24 of 255). Averaging over blocks ignores edge antialiasing, which
 * differs where an element is or is not on its own compositing layer, and keeps every real change
 * (a stud, a cell, a lit node, a figure out of place). Decoded in a blank page.
 */
async function differingShare(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<number> {
  const ratio = await page.evaluate(() => devicePixelRatio);
  const scratch = await page.context().newPage();
  try {
    return await scratch.evaluate(
      async ([first, second, dpr]) => {
        const pixels = async (data: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height);
        };
        const [one, two] = await Promise.all([pixels(first), pixels(second)]);
        if (one.width !== two.width || one.height !== two.height) return 1;
        const block = Math.max(4, Math.round(4 * dpr));
        const columns = Math.floor(one.width / block);
        const rows = Math.floor(one.height / block);
        let differing = 0;
        for (let by = 0; by < rows; by += 1)
          for (let bx = 0; bx < columns; bx += 1) {
            const sum = [0, 0, 0];
            for (let y = by * block; y < (by + 1) * block; y += 1)
              for (let x = bx * block; x < (bx + 1) * block; x += 1) {
                const i = (y * one.width + x) * 4;
                for (let c = 0; c < 3; c += 1)
                  sum[c] += one.data[i + c] - two.data[i + c];
              }
            if (Math.max(...sum.map((v) => Math.abs(v))) / (block * block) > 24)
              differing += 1;
          }
        return differing / (columns * rows);
      },
      [a.toString('base64'), b.toString('base64'), ratio] as const,
    );
  } finally {
    await scratch.close();
  }
}

/**
 * The figure's server-rendered final state, in the same page and place: every animation in it
 * cancelled (its moving parts are drawn transparent until the story moves them).
 */
async function served(figure: Locator): Promise<Buffer> {
  await figure.evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.cancel()),
  );
  return figure.locator('[data-figure-stage]').screenshot();
}

async function attach(info: TestInfo, name: string, png: Buffer) {
  await info.attach(name, { body: png, contentType: 'image/png' });
}

/** Where each element is drawn: the centre of its box on screen, CSS px (for `evaluateAll`). */
const centres = (elements: Element[]) =>
  elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

test.beforeEach(async ({ page, isMobile }) => {
  await page.setViewportSize(viewportFor(isMobile));
});

/* ------------------------------------------------------------------------- the people figure */

test('the people figure draws 100 people, 86 · 13 · 1 in that order, the ring’s leader ending at the note', async ({
  page,
  isMobile,
}) => {
  await page.goto('/');
  const figure = people(page);
  await seek(figure, 'people', 2100);
  const svg = shown(figure, 'svg[data-layout]');
  await expect(svg).toHaveAttribute(
    'data-layout',
    isMobile ? 'narrow' : 'wide',
  );
  const groups = await svg
    .locator('[data-person]')
    .evaluateAll((uses) => uses.map((use) => use.getAttribute('data-person')));
  expect(groups).toHaveLength(100);
  expect(groups.filter((group) => group === 'european')).toHaveLength(86);
  expect(groups.filter((group) => group === 'other')).toHaveLength(13);
  expect(groups.filter((group) => group === 'african')).toHaveLength(1);
  // Reading order: the one African-ancestry person is the last place in the grid (where each
  // person is drawn, not how the markup places it).
  const places = await svg.locator('.people__p').evaluateAll(centres);
  const [african] = await svg
    .locator('[data-person="african"]')
    .evaluateAll(centres);
  const last = places[99];
  expect(Math.abs(african.x - last.x)).toBeLessThan(0.5);
  expect(Math.abs(african.y - last.y)).toBeLessThan(0.5);
  // The last place is the bottom row's right end.
  expect(Math.max(...places.map(({ y }) => y))).toBeCloseTo(last.y, 1);
  expect(Math.max(...places.map(({ x }) => x))).toBeCloseTo(last.x, 1);

  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const person = await box(svg.locator('[data-person="african"]'));
  const ring = await box(svg.locator('.people__ring'));
  const leader = await box(svg.locator('.people__leader'));
  const note = await box(figure.locator('.people__note'));
  // The ring frames that person; the leader drops from the ring to the note, inside its width.
  expect(ring.x).toBeLessThan(person.x);
  expect(ring.x + ring.width).toBeGreaterThan(person.x + person.width);
  expect(Math.abs(leader.y - (ring.y + ring.height))).toBeLessThan(2.5);
  expect(Math.abs(leader.y + leader.height - note.y)).toBeLessThan(6);
  expect(leader.x).toBeGreaterThan(note.x);
  expect(leader.x).toBeLessThan(note.x + note.width);
  // The stage is one image, named in full; the people are aria-hidden drawings.
  await expect(figure.locator('[data-figure-stage]')).toHaveAttribute(
    'role',
    'img',
  );
  await expect(
    figure.getByRole('img', {
      name: /^Of every 100 participants in genome-wide studies up to July 2021, 86 had European ancestry, 1 had African ancestry, and 13 had another ancestry or none recorded\./,
    }),
  ).toBeVisible();
});

test('the people arrive in a diagonal wave, settle into their groups, and end on the final figure', async ({
  page,
}, info) => {
  await page.goto('/');
  const figure = people(page);
  const svg = () => shown(figure, 'svg[data-layout]');
  const opacity = (locator: Locator) =>
    locator.evaluate((element) => Number(getComputedStyle(element).opacity));
  await seek(figure, 'people', 300);
  // The first person is in; the last, at the end of the diagonal, is not yet.
  expect(await opacity(svg().locator('.people__p').first())).toBeGreaterThan(
    0.9,
  );
  expect(await opacity(svg().locator('.people__p').last())).toBeLessThan(0.1);
  // At 1.2 s everyone is in and the 13 and the 1 are settling into their tones; the note waits.
  await seek(figure, 'people', 1200);
  expect(await opacity(svg().locator('.people__p').last())).toBe(1);
  const tone = await opacity(svg().locator('.people__tone').first());
  expect(tone).toBeGreaterThan(0.05);
  expect(tone).toBeLessThan(0.95);
  expect(
    await figure
      .locator('.people__note')
      .evaluate((note) => getComputedStyle(note).clipPath),
  ).toMatch(/inset\(0px 0px 100%/);
  for (const ms of [500, 1200, 2200]) {
    await seek(figure, 'people', ms);
    await attach(info, `people-${ms}`, await figure.screenshot());
  }
  // The story's last frame is the server-rendered figure, at rest.
  await seek(figure, 'people', 2100);
  const end = await figure.locator('[data-figure-stage]').screenshot();
  expect(await differingShare(page, end, await served(figure))).toBe(0);
});

test('each person grows in place: mid-wave, every glyph is centred where it rests', async ({
  page,
}) => {
  await page.goto('/');
  const figure = people(page);
  const svg = () => shown(figure, 'svg[data-layout]');
  const glyphs = () =>
    svg()
      .locator('.people__p')
      .evaluateAll((uses) =>
        uses.map((use) => {
          const box = use.getBoundingClientRect();
          return {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            width: box.width,
            shown: Number(getComputedStyle(use).opacity) > 0.02,
          };
        }),
      );
  await seek(figure, 'people', 2100);
  const rest = await glyphs();
  expect(rest).toHaveLength(100);
  // 300 ms: the wave is half way across; 500 ms: everyone is in and many are still growing.
  for (const ms of [300, 500]) {
    await seek(figure, 'people', ms);
    const now = await glyphs();
    // The check has teeth: many people are visible and still growing at this instant.
    const growing = now.filter(
      ({ width, shown }, index) => shown && width < rest[index].width - 0.5,
    );
    expect(growing.length, `${ms} ms`).toBeGreaterThan(10);
    const drift = now.map(({ x, y }, index) =>
      Math.hypot(x - rest[index].x, y - rest[index].y),
    );
    expect(Math.max(...drift), `${ms} ms`).toBeLessThan(1.5);
  }
});

test('the people keep their desktop size at every width, and “Why it matters” stacks until the wide grid fits beside its text @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [600, 700, 834, 900, 991, 992, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const figure = people(page);
    const svg = shown(figure, 'svg[data-layout]');
    // The drawn glyph's box (a <use>'s client rect; Playwright's boundingBox() reports the
    // larger box of the <use>'s viewport).
    const glyph = await svg
      .locator('.people__p')
      .first()
      .evaluate((use) => use.getBoundingClientRect().width);
    // Never larger than at desktop widths (about 25 px), never too small to read as a person.
    expect(glyph, `${width}`).toBeLessThanOrEqual(26.5);
    expect(glyph, `${width}`).toBeGreaterThanOrEqual(16);
    const stage = (await figure.locator('[data-figure-stage]').boundingBox())!;
    expect(stage.height, `${width}`).toBeLessThanOrEqual(600);
    // Beside its text only where the 20 × 5 grid fits; otherwise under it, at full width.
    const text = (await page
      .locator('#why .layout-figure-split__text')
      .boundingBox())!;
    const beside = (await figure.boundingBox())!.x > text.x + text.width;
    expect(beside, `${width}`).toBe(width >= 992);
    if (beside)
      await expect(svg, `${width}`).toHaveAttribute('data-layout', 'wide');
  }
});

// Design critique 4: at 1440 the 562 px grid sat at the left of an 874 px column, under a key row
// that spanned the whole column, so the figure looked lopsided. Beside its text the figure is its
// grid's width, centred in its column; the note keeps its words and its two lines (rulings 55, 56).
test('beside its text the people figure is its grid’s width, centred in its column @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const layout = await people(page).evaluate((element) => {
      const box = (node: Element) => node.getBoundingClientRect();
      const column = box(element.parentElement!);
      const svg = [...element.querySelectorAll('.people__svg')].find(
        (drawing) => getComputedStyle(drawing).display !== 'none',
      )!;
      const grid = box(svg);
      const leader = box(svg.querySelector('.people__leader')!);
      return {
        left: grid.left - column.left,
        right: column.right - grid.right,
        grid: [grid.left, grid.right],
        parts: [
          '.people__title',
          '.people__note',
          '.kit-figure__legend',
          '.kit-figure__footnote',
        ].map((selector) => {
          const part = box(element.querySelector(selector)!);
          return { selector, left: part.left, right: part.right };
        }),
        note: [
          ...element.querySelectorAll<HTMLElement>('.people__note > span'),
        ].map((line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          return {
            text: line.textContent,
            lines: range.getClientRects().length,
            right: range.getBoundingClientRect().right,
          };
        }),
        leader: leader.left + leader.width / 2,
      };
    });
    expect(
      Math.abs(layout.left - layout.right),
      `${width} centred`,
    ).toBeLessThan(1.5);
    const [left, right] = layout.grid;
    for (const part of layout.parts) {
      expect(part.left, `${width} ${part.selector}`).toBeGreaterThanOrEqual(
        left - 0.5,
      );
      expect(part.right, `${width} ${part.selector}`).toBeLessThanOrEqual(
        right + 0.5,
      );
    }
    expect(layout.note.map(({ text }) => text)).toEqual([
      'Populations with the greatest genetic diversity',
      'are the least represented in research.',
    ]);
    for (const line of layout.note) {
      expect(line.lines, `${width}: ${line.text}`).toBe(1);
      // Right-aligned, ending just past the leader that drops to it.
      expect(
        Math.abs(line.right - right),
        `${width}: ${line.text}`,
      ).toBeLessThan(1.5);
    }
    expect(right - layout.leader, `${width} leader`).toBeGreaterThan(0);
    expect(right - layout.leader, `${width} leader`).toBeLessThan(24);
  }
});

/* ------------------------------------------------------------------------- how it works */

const STORYBOARD = [
  // Per seek: steps 2 and 3 lit; records, measured studs and estimate hexes on their wires; the
  // cursor arrived. (At 2.6 s the first hex is only leaving the model, still transparent.)
  {
    ms: 700,
    two: false,
    three: false,
    records: true,
    studs: false,
    hexes: false,
    cursor: false,
  },
  {
    ms: 1600,
    two: false,
    three: false,
    records: true,
    studs: true,
    hexes: false,
    cursor: false,
  },
  {
    ms: 2600,
    two: true,
    three: false,
    records: false,
    studs: true,
    hexes: false,
    cursor: false,
  },
  {
    ms: 3400,
    two: true,
    three: true,
    records: false,
    studs: false,
    hexes: true,
    cursor: false,
  },
  {
    ms: 4900,
    two: true,
    three: true,
    records: false,
    studs: false,
    hexes: false,
    cursor: true,
  },
] as const;

test('the steps play their storyboard: records in, studs on the measured lane past the model, estimates out', async ({
  page,
}, info) => {
  await page.goto('/');
  const figure = steps(page);
  for (const frame of STORYBOARD) {
    await seek(figure, 'how-it-works', frame.ms);
    const state = await figure.evaluate((element) => {
      const svg = [
        ...element.querySelectorAll<SVGSVGElement>('svg[data-layout]'),
      ].find((candidate) => candidate.getClientRects().length > 0)!;
      const visible = (selector: string) =>
        [...svg.querySelectorAll<SVGGraphicsElement>(selector)].filter(
          (node) => Number(getComputedStyle(node).opacity) > 0.05,
        );
      const lit = (step: string) =>
        Number(
          getComputedStyle(
            element.querySelector(`.hiw-step[data-step="${step}"]`)!,
          ).getPropertyValue('--hiw-lit'),
        );
      const model = svg.querySelector('.hiw-model')!.getBoundingClientRect();
      const inside = visible('.hiw-stud[data-lane="measured"]').filter(
        (stud) => {
          const box = stud.getBoundingClientRect();
          return (
            Math.min(box.right, model.right) - Math.max(box.left, model.left) >
              0 &&
            Math.min(box.bottom, model.bottom) - Math.max(box.top, model.top) >
              0
          );
        },
      );
      const cells = [...svg.querySelectorAll('.atlas-mark__cells path')].map(
        (cell) => Number(getComputedStyle(cell).opacity),
      );
      return {
        two: lit('2'),
        three: lit('3'),
        records: visible('.hiw-record').length,
        studs: visible('.hiw-stud[data-lane="measured"]').length,
        hexes: visible('.hiw-tokens > path').length,
        inside: inside.length,
        cursor: Number(
          getComputedStyle(svg.querySelector('.hiw-cursor')!).opacity,
        ),
        cellsIn: cells.filter((value) => value > 0.95).length,
        cells: cells.length,
      };
    });
    const at = `${frame.ms} ms`;
    expect(state.two, `${at} step 2`).toBeCloseTo(frame.two ? 1 : 0, 2);
    expect(state.three, `${at} step 3`).toBeCloseTo(frame.three ? 1 : 0, 2);
    expect(state.records > 0, `${at} records`).toBe(frame.records);
    expect(state.studs > 0, `${at} measured studs`).toBe(frame.studs);
    expect(state.hexes > 0, `${at} hexes`).toBe(frame.hexes);
    // A measurement on the measured lane never goes through the model (round 1 §6.1 rule 1).
    expect(state.inside, `${at} studs inside the model`).toBe(0);
    expect(state.cursor, `${at} cursor`).toBeCloseTo(frame.cursor ? 1 : 0, 2);
    // The globe is empty before the estimates arrive and full at rest.
    if (frame.ms <= 2600) expect(state.cellsIn, at).toBe(0);
    if (frame.ms === 4900) expect(state.cellsIn, at).toBe(state.cells);
    await attach(info, `steps-${frame.ms}`, await figure.screenshot());
  }
});

test('a seek is deterministic: the same moment draws the same frame', async ({
  page,
}) => {
  await page.goto('/');
  const figure = steps(page);
  const stage = figure.locator('[data-figure-stage]');
  for (const ms of [1600, 3400]) {
    await seek(figure, 'how-it-works', ms);
    const first = await stage.screenshot();
    await seek(figure, 'how-it-works', 0);
    await seek(figure, 'how-it-works', ms);
    const second = await stage.screenshot();
    expect(await differingShare(page, first, second), `${ms} ms`).toBe(0);
  }
});

test('the steps end on the server-rendered figure, and a moment before it does not', async ({
  page,
}) => {
  await page.goto('/');
  const figure = steps(page);
  const stage = figure.locator('[data-figure-stage]');
  // At 4.5 s the cursor is still gliding: the comparison sees it.
  await seek(figure, 'how-it-works', 4500);
  const before = await stage.screenshot();
  await seek(figure, 'how-it-works', 4900);
  const end = await stage.screenshot();
  const rest = await served(figure);
  expect(await differingShare(page, before, rest)).toBeGreaterThan(0);
  expect(await differingShare(page, end, rest)).toBe(0);
});

test('the steps play once at 35% visible, rest, and Replay plays them again', async ({
  page,
}) => {
  await page.goto('/');
  const figure = steps(page);
  const replay = figure.getByRole('button', { name: 'Replay the three steps' });
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-scene-state', 'playing');
  await expect(figure).toHaveAttribute('data-scene-state', 'rest', {
    timeout: 8000,
  });
  // Replay is a white glyph with no label of its own (rulings item 22), 44 px square.
  await expect(replay).toBeVisible();
  const target = (await replay.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await replay.click();
  await expect(figure).toHaveAttribute('data-scene-state', 'playing');
  expect(
    await page.evaluate(() => window.__motion!.time('how-it-works')),
  ).toBeLessThan(1500);
  // From the start again: step 3 is dim until 3 s.
  expect(
    await figure
      .locator('.hiw-step[data-step="3"]')
      .evaluate((step) =>
        Number(getComputedStyle(step).getPropertyValue('--hiw-lit')),
      ),
  ).toBeLessThan(0.5);
  // There is no Pause: the story is under 5 s and does not loop (WCAG 2.2.2).
  await expect(figure.getByRole('button', { name: /^Pause\b/ })).toHaveCount(0);
});

// Design critique 4 (ruling 59): the plate's top bar was an empty 58 px strip with a rule under it,
// holding only the Replay glyph. Now the glyph sits in the drawing's top-right corner, in a row no
// taller than its target, off the stage and clear of everything drawn.
test('the steps plate has no top bar: Replay sits in the drawing’s top-right corner', async ({
  page,
  isMobile,
}) => {
  const widths = isMobile ? [390, 320] : [1440, 1024, 800];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const figure = steps(page);
    const replay = figure.getByRole('button', {
      name: 'Replay the three steps',
    });
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'rest', {
      timeout: 8000,
    });
    await expect(replay).toBeVisible();
    const geometry = await figure.evaluate((element) => {
      const box = (node: Element) => node.getBoundingClientRect();
      const plate = box(element);
      const row = element.querySelector('.kit-plate__bar--top')!;
      const stage = box(element.querySelector('[data-figure-stage]')!);
      const control = box(element.querySelector('[data-scene-replay]')!);
      const svg = [...element.querySelectorAll('.hiw-svg')].find(
        (drawing) => getComputedStyle(drawing).display !== 'none',
      )!;
      const drawn = [
        ...svg.querySelectorAll(
          '.hiw-socket, .hiw-icon, .hiw-label, .hiw-gate, .hiw-nodes circle, .atlas-mark, .hiw-cursor',
        ),
      ].filter((part) => {
        const b = box(part);
        return (
          b.right > control.left &&
          b.left < control.right &&
          b.bottom > control.top &&
          b.top < control.bottom
        );
      }).length;
      // The wires, sampled along their length.
      let wired = 0;
      for (const wire of svg.querySelectorAll<SVGPathElement>('.hiw-wire')) {
        const length = wire.getTotalLength();
        const matrix = wire.getScreenCTM()!;
        for (let step = 0; step <= 200; step += 1) {
          const point = wire
            .getPointAtLength((length * step) / 200)
            .matrixTransform(matrix);
          if (
            point.x > control.left &&
            point.x < control.right &&
            point.y > control.top &&
            point.y < control.bottom
          )
            wired += 1;
        }
      }
      return {
        rule: getComputedStyle(row).borderBottomWidth,
        fromTop: control.top - plate.top,
        stageRight: stage.right - control.right,
        offStage: stage.top - control.bottom,
        drawingTop: box(svg).top - plate.top,
        drawn,
        wired,
      };
    });
    expect(geometry.rule, `${width}`).toBe('0px');
    // In the corner: within 12 px of the plate's top and of the stage's right edge.
    expect(geometry.fromTop, `${width}`).toBeLessThanOrEqual(12);
    expect(geometry.stageRight, `${width}`).toBeGreaterThanOrEqual(0);
    expect(geometry.stageRight, `${width}`).toBeLessThanOrEqual(12);
    // Off the stage (round 2 spec §3.5), and the drawing starts right under it.
    expect(geometry.offStage, `${width}`).toBeGreaterThanOrEqual(-0.5);
    expect(geometry.drawingTop, `${width}`).toBeLessThanOrEqual(56);
    expect(geometry.drawn, `${width}: drawn parts under Replay`).toBe(0);
    expect(geometry.wired, `${width}: wire points under Replay`).toBe(0);
  }
});

test('each step’s number sits level with the first line of its title, also when a title wraps @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The number is the title's ::before; DevTools reports a pseudo-element's box.
  const cdp = await page.context().newCDPSession(page);
  type Node = {
    nodeId: number;
    pseudoType?: string;
    children?: Node[];
    pseudoElements?: Node[];
  };
  // At 1024 px "Explore the genomeOS Atlas" takes two lines; at 1440 every title takes one.
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await steps(page).scrollIntoViewIfNeeded();
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1 })) as {
      root: Node;
    };
    const nodes = new Map<number, Node>();
    const walk = (node: Node) => {
      nodes.set(node.nodeId, node);
      node.children?.forEach(walk);
    };
    walk(root);
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '.hiw-step h3',
    });
    expect(nodeIds).toHaveLength(3);
    const badges: { top: number; middle: number }[] = [];
    for (const nodeId of nodeIds) {
      const before = nodes
        .get(nodeId)!
        .pseudoElements!.find(({ pseudoType }) => pseudoType === 'before')!;
      const { model } = await cdp.send('DOM.getBoxModel', {
        nodeId: before.nodeId,
      });
      const [, top, , , , bottom] = model.border;
      badges.push({ top, middle: (top + bottom) / 2 });
    }
    const lines = await steps(page)
      .locator('.hiw-step h3')
      .evaluateAll((titles) =>
        titles.map((title) => {
          // The text's own line boxes (not its wrapping span's box).
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
          const rects: DOMRect[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...range.getClientRects());
          }
          const first = rects[0];
          return {
            middle: first.y + first.height / 2,
            lines: new Set(rects.map(({ y }) => Math.round(y))).size,
          };
        }),
      );
    if (width === 1024)
      expect(lines[2].lines, 'step 3 wraps at 1024').toBeGreaterThan(1);
    for (const [index, badge] of badges.entries())
      expect(
        Math.abs(badge.middle - lines[index].middle),
        `${width}: step ${index + 1}`,
      ).toBeLessThan(2);
    // The three badges stand in one row.
    expect(
      Math.max(...badges.map(({ top }) => top)) -
        Math.min(...badges.map(({ top }) => top)),
      `${width}`,
    ).toBeLessThan(1);
  }
});

/* ------------------------------------------------------------------------------ the crew */

test('the crew hops in one by one, then rests', async ({ page }, info) => {
  await page.goto('/');
  const figure = crew(page);
  const members = () => shown(figure, '.crew__layout').locator('.crew__member');
  const opacity = (locator: Locator) =>
    locator.evaluate((element) => Number(getComputedStyle(element).opacity));
  await seek(figure, 'crew', 300);
  expect(await opacity(members().first())).toBe(1);
  expect(await opacity(members().last())).toBe(0);
  await attach(info, 'crew-300', await figure.screenshot());
  await seek(figure, 'crew', 2200);
  for (const member of await members().all())
    expect(await opacity(member)).toBe(1);
  const end = await figure.locator('[data-figure-stage]').screenshot();
  await attach(info, 'crew-2200', end);
  expect(await differingShare(page, end, await served(figure))).toBe(0);
});

test('the crew is named for the people drawn: four on a wide figure, three on a phone', async ({
  page,
  isMobile,
}) => {
  await page.goto('/');
  const stage = crew(page).locator('[data-figure-stage]');
  await expect(stage).toHaveAccessibleName(
    isMobile
      ? 'Three people at work: a coder, an expert thinking and a data person, with an empty spot for you.'
      : 'Four people at work: a coder, a builder, an expert thinking and a data person, with an empty spot for you.',
  );
  const drawn = await shown(crew(page), '.crew__layout')
    .locator('.crew__member')
    .count();
  expect(drawn).toBe(isMobile ? 3 : 4);
});

// Review of T2: between 600 and 1,000 px the narrow crew's 420-unit drawing ran at full width, so
// its astronauts stood about 150 px tall, half as tall again as at 1440 (about 100 px).
test('the crew stays about desktop size at every width @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 600, 800, 1000, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const heights = await shown(crew(page), '.crew__layout')
      .locator('.crew__member')
      .evaluateAll((members) =>
        members.map((member) => member.getBoundingClientRect().height),
      );
    expect(heights.length, `${width}`).toBeGreaterThan(2);
    expect(Math.max(...heights), `${width}`).toBeLessThanOrEqual(110);
  }
});

// Design critique 4: top-aligned, the crew and its cards ended about 420 px into the section at
// 1440 and left some 240 px empty under them beside the two-paragraph lede. From 60rem the figure
// stands level with the text's middle; where it is the taller of the two, it starts with the text.
test('beside the lede the crew and its cards stand level with the text’s middle @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const [text, figure] = await Promise.all(
      ['#join .layout-figure-split__text', '#join .home-join__figure'].map(
        async (selector) => (await page.locator(selector).boundingBox())!,
      ),
    );
    const middle = (box: { y: number; height: number }) =>
      box.y + box.height / 2;
    if (figure.height < text.height)
      expect(
        Math.abs(middle(figure) - middle(text)),
        `${width} centred`,
      ).toBeLessThan(1.5);
    else expect(Math.abs(figure.y - text.y), `${width} top`).toBeLessThan(1.5);
  }
});

test('focusing each card fills "Your spot", and moving on empties it', async ({
  page,
}) => {
  await page.goto('/');
  const figure = crew(page);
  const newcomer = () =>
    shown(figure, '.crew__layout').locator('.crew__newcomer');
  const spot = () => shown(figure, '.crew__layout').locator('.crew__spot');
  const opacity = (locator: Locator) =>
    locator.evaluate((element) => Number(getComputedStyle(element).opacity));
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  const cards = page.locator('#join [data-crew-cta]');
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    await card.focus();
    await expect(figure).toHaveAttribute('data-filled', '');
    await expect.poll(() => opacity(newcomer())).toBe(1);
    await expect.poll(() => opacity(spot())).toBe(0);
    await card.blur();
    await expect(figure).not.toHaveAttribute('data-filled');
    await expect.poll(() => opacity(newcomer())).toBe(0);
    await expect.poll(() => opacity(spot())).toBe(1);
  }
});

// Review of T2: tabbing straight to the cards scrolls them into view, which started the crew's
// hop-in just as the newcomer dropped into "Your spot", among astronauts still in the air.
test('a card focused before the crew has landed lands it at once', async ({
  page,
}) => {
  await page.goto('/');
  const figure = crew(page);
  await page.locator('#join [data-crew-cta]').first().focus();
  await expect(figure).toHaveAttribute('data-filled', '');
  await page.evaluate(() => window.__motion!.ready('crew'));
  // The story takes 2.2 s: landed within a second means it never played around the newcomer.
  await expect
    .poll(() => page.evaluate(() => window.__motion!.time('crew')), {
      timeout: 1000,
    })
    .toBeGreaterThanOrEqual(2200);
  for (const member of await shown(figure, '.crew__layout')
    .locator('.crew__member')
    .all())
    expect(
      await member.evaluate((element) =>
        Number(getComputedStyle(element).opacity),
      ),
    ).toBe(1);
});

// Hover is a pointer interaction.
test('hovering each card fills "Your spot", and leaving empties it @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  const figure = crew(page);
  const newcomer = shown(figure, '.crew__layout').locator('.crew__newcomer');
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  for (const card of await page.locator('#join [data-crew-cta]').all()) {
    await card.hover();
    await expect(figure).toHaveAttribute('data-filled', '');
    await expect
      .poll(() =>
        newcomer.evaluate((element) =>
          Number(getComputedStyle(element).opacity),
        ),
      )
      .toBe(1);
    await page.mouse.move(5, 5);
    await expect(figure).not.toHaveAttribute('data-filled');
  }
});

/* ------------------------------------------------------------- reduced motion, no script */

test('reduced motion: every Home figure is whole at once, nothing is built, and the spot swaps instantly', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const figure of [people(page), steps(page), crew(page)]) {
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(250);
    expect(
      await figure.evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
  }
  // The modules were never imported, so no scene registered.
  expect(
    await page.evaluate(() =>
      (window.__motion?.names() ?? []).filter((name) =>
        ['people', 'how-it-works', 'crew'].includes(name),
      ),
    ),
  ).toEqual([]);
  for (const step of ['1', '2', '3'])
    expect(
      await steps(page)
        .locator(`.hiw-step[data-step="${step}"]`)
        .evaluate((element) =>
          Number(getComputedStyle(element).getPropertyValue('--hiw-lit')),
        ),
    ).toBe(1);
  await expect(steps(page).locator('[data-scene-replay]')).toBeHidden();
  await expect(people(page).locator('.people__note')).toBeVisible();
  await expect(
    shown(people(page), 'svg[data-layout]').locator('.people__p'),
  ).toHaveCount(100);
  // The newcomer swaps in without a transition.
  await page.locator('#join [data-crew-cta]').first().focus();
  expect(
    await shown(crew(page), '.crew__layout')
      .locator('.crew__newcomer')
      .evaluate((element) => Number(getComputedStyle(element).opacity)),
  ).toBe(1);
});

test('in forced colours the scenes rest, their lines and labels in the system text colour', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  for (const figure of [people(page), steps(page), crew(page)]) {
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(250);
    expect(
      await figure.evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
  }
  const text = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'CanvasText';
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  const stroke = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).stroke);
  const fill = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fill);
  const svg = shown(people(page), 'svg[data-layout]');
  expect(await stroke(svg.locator('.people__ring'))).toBe(text);
  expect(await stroke(svg.locator('.people__leader'))).toBe(text);
  const stage = shown(steps(page), 'svg[data-layout]');
  expect(await stroke(stage.locator('[data-wire="measured"]'))).toBe(text);
  expect(await fill(stage.locator('.hiw-label').first())).toBe(text);
  await expect(steps(page).locator('.kit-plate__bar--top')).toBeHidden();
});

test('without JavaScript the hero shows its poster and every figure its final state', async ({
  browser,
  isMobile,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: viewportFor(isMobile),
  });
  const page = await context.newPage();
  await page.goto('/');
  const heroPoster = page.locator('.hero-media__poster');
  await expect(heroPoster).toBeVisible();
  await expect(heroPoster).toHaveJSProperty('complete', true);
  await expect(page.locator('.hero-media__video source')).toHaveCount(0);
  await expect(page.locator('[data-video-toggle]')).toBeHidden();
  // The preview keeps its poster; nothing turns, so it offers no Pause.
  const preview = page.locator('figure[data-graphic="atlas-preview"]');
  await preview.scrollIntoViewIfNeeded();
  await expect(preview.locator('.hg-poster')).toBeVisible();
  await expect(preview.locator('[data-spin-toggle]')).toBeHidden();
  // Home's own figures, whole: 100 people, the note, all three steps lit, the globe's cells and
  // studs, the crew at work, and no Replay.
  await expect(
    shown(people(page), 'svg[data-layout]').locator('.people__p'),
  ).toHaveCount(100);
  await expect(people(page).locator('.people__note')).toBeVisible();
  for (const step of ['1', '2', '3'])
    expect(
      await steps(page)
        .locator(`.hiw-step[data-step="${step}"]`)
        .evaluate((element) =>
          Number(getComputedStyle(element).getPropertyValue('--hiw-lit')),
        ),
    ).toBe(1);
  await expect(steps(page).locator('[data-scene-replay]')).toBeHidden();
  const svg = shown(steps(page), 'svg[data-layout]');
  await expect(svg.locator('.atlas-mark__studs circle')).toHaveCount(6);
  for (const member of await shown(crew(page), '.crew__layout')
    .locator('.crew__member')
    .all())
    await expect(member).toBeVisible();
  await context.close();
});

/* ------------------------------------------------------------------- type and navigation */

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
      '.home-lede',
      '.hiw-step p',
      '.people__key li',
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
  for (const [selector, size] of Object.entries(typeSizes))
    if (selector !== 'body') expect(size, selector).toBeGreaterThanOrEqual(16);
});

test('“How it works” takes the visitor down to the three steps, below the header', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page
    .locator('#hero')
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(page).toHaveURL(/#how$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const header = document
          .querySelector('[data-site-header]')!
          .getBoundingClientRect().bottom;
        const top = document.querySelector('#how')!.getBoundingClientRect().top;
        return Math.abs(top - header) < 40;
      }),
    )
    .toBe(true);
});

test('Home fits every phone width without sideways scrolling, its figures inside the gutters @mobile-chromium', async ({
  page,
}) => {
  for (const width of [320, 360, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width}`).toBe(0);
    for (const selector of [
      'figure[data-graphic="people"]',
      'figure[data-graphic="how-it-works"]',
      'figure[data-graphic="crew"]',
      '#join [data-crew-cta]',
    ]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.x, `${width} ${selector}`).toBeGreaterThanOrEqual(15.5);
      expect(box.x + box.width, `${width} ${selector}`).toBeLessThanOrEqual(
        width - 15.5,
      );
    }
  }
});
