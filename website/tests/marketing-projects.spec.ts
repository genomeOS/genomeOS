/**
 * Projects page browser checks (site redesign spec §4.2, §9.1; round 2 spec §4.2, §11.2; rulings
 * 35–39; the owner's restructure of 2026-10-15; #454). Owned by the Projects task.
 *
 * The project index opens above the fold; the Atlas chapter opens on an overview of the essentials
 * and keeps the rest in four sections, closed by default: they open and close by click and by
 * keyboard, a deep link opens its section on load and on hashchange, a closed section loads no
 * script or data, opening one plays its figures' entrances once, and printing opens every one.
 * Inside them: the roadmap's three states in order; the HbS genotype triad driving the map, the
 * threshold slider, its count and spoken value, and survey readouts in people; the counts figure's
 * slider at every stop with its value labels inside the figure; the application cards; the
 * safeguard tiles playing once and resting; the Pipeline's 6 ↔ 3 toggle; the join-up's field
 * reasons and record replay; and the map's keyboard readout. The cross-page suites (word budget,
 * figures, motion) cover the rest.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { visibleWords } from './helpers/manifest-page';
import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

type Section = 'hbs' | 'uses' | 'how' | 'status';
const SECTIONS: readonly Section[] = ['hbs', 'uses', 'how', 'status'];

const sectionRow = (page: Page, name: Section) =>
  page.locator(`details.acc[data-acc="${name}"]`);

/**
 * Open a collapsed section of the Atlas chapter, as a visitor does: a click on its summary. Its
 * figures load then; `data-acc-ready` says they are set up.
 */
async function openSection(page: Page, name: Section) {
  const section = sectionRow(page, name);
  if (!(await section.evaluate((details: HTMLDetailsElement) => details.open)))
    await section.locator(':scope > summary').click();
  await expect(section).toHaveJSProperty('open', true);
  await expect(section).toHaveAttribute('data-acc-ready', '');
  // The opening transition has ended: the section is as tall as its summary and body, so the page
  // is its full height again (a jump scroll before then is clamped to the shorter page).
  await expect
    .poll(() =>
      section.evaluate((details) => {
        const height = (selector: string) =>
          details.querySelector(selector)!.getBoundingClientRect().height;
        return (
          details.getBoundingClientRect().height >=
          height(':scope > summary') + height(':scope > .acc__body') - 1
        );
      }),
    )
    .toBe(true);
  return section;
}

/** Bring a figure into view and wait for the HbS map's data, when that is the figure. */
async function hbsReady(page: Page) {
  await openSection(page, 'hbs');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-hbs-ready', '');
  return figure;
}

test('project page labels all three capability states, in order', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'status');
  const names = [
    'Available now',
    'In active development',
    'Future exploration',
  ];
  const tops: number[] = [];
  const lefts: number[] = [];
  for (const name of names) {
    const heading = page.getByRole('heading', { level: 4, name, exact: true });
    await expect(heading).toBeVisible();
    const box = (await heading.boundingBox())!;
    tops.push(box.y);
    lefts.push(box.x);
  }
  // Left to right on a wide screen, top to bottom on a phone: never out of order.
  for (let index = 1; index < names.length; index += 1)
    expect(
      lefts[index] > lefts[index - 1] || tops[index] > tops[index - 1],
      names[index],
    ).toBe(true);
  // No scare tag on the Atlas item (R2-14): the gate and the active list say where validation is.
  const rail = page.locator('figure[data-graphic="status-rail"]');
  await expect(rail.locator('.kit-status-tag')).toHaveCount(0);
  await expect(
    rail.getByText('Validation against published estimates'),
  ).toBeVisible();
});

test('the threshold slider changes the count and its spoken value', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = await hbsReady(page);
  const slider = figure.getByRole('slider');
  const count = figure.locator('[data-hbs-count]');
  // The default is 5%, where some areas are confidently above, so both outlines show at rest.
  await expect(slider).toHaveValue('5');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^5 percent: [1-9]\d* areas confidently above, \d+ possibly above$/,
  );
  const atDefault = await count.textContent();

  await slider.fill('10');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^10 percent: \d+ areas confidently above, \d+ possibly above$/,
  );
  await expect(count).not.toHaveText(atDefault!);
  await expect(count).toHaveText(
    /^\d+ confidently above · \d+ possibly above$/,
  );
  await expect(figure.locator('[data-hbs-threshold]')).toHaveText('10%');

  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('11');
  await expect(slider).toHaveAttribute('aria-valuetext', /^11 percent:/);
});

test('selecting SS draws the sickled cell', async ({ page }) => {
  await page.goto('/projects/');
  await openSection(page, 'hbs');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  const group = figure.getByRole('group', { name: 'Genotype', exact: true });
  await group.scrollIntoViewIfNeeded();
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await group.getByRole('button', { name: /^SS/ }).click();
  await expect(group.getByRole('button', { name: /^SS/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(figure.locator('[data-genotype]')).toHaveAttribute(
    'data-genotype',
    'SS',
  );
  // The trait's description is the catalog's own wording.
  await expect(
    group.getByRole('button', { name: /^AS/ }),
  ).toHaveAccessibleDescription(
    'sickle-cell trait, associated with protection from severe malaria',
  );
});

// AA and AS draw the same disc (a carrier's red cells look like anyone else's), so the frame
// says which pair it shows: pressing AS after AA visibly changes the frame (design review,
// round 1). The slider is the site's one range style: a hairline track and a square thumb.
test('the cell frame names the pressed allele pair, so AS after AA changes it', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'hbs');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  const group = figure.getByRole('group', { name: 'Genotype', exact: true });
  await group.scrollIntoViewIfNeeded();
  for (const genotype of ['AA', 'AS', 'SS']) {
    await group
      .getByRole('button', { name: new RegExp(`^${genotype}`) })
      .click();
    for (const other of ['AA', 'AS', 'SS'])
      if (other === genotype)
        await expect(figure.locator(`[data-pair="${other}"]`)).toBeVisible();
      else await expect(figure.locator(`[data-pair="${other}"]`)).toBeHidden();
  }
  await expect(figure.getByRole('slider')).toHaveCSS('appearance', 'none');
});

// Five links in equal cards, three over two (link rows set in 2–4 columns, spec §2.4), never a
// wide card plus odd ones (design review, round 1).
test('the follow-the-work links are equal cards in whole rows @desktop-chromium', async ({
  page,
}) => {
  for (const width of [1100, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/projects/');
    const boxes = await page
      .locator('.proj-links > li')
      .evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().toJSON()),
      );
    expect(boxes, `${width}`).toHaveLength(5);
    for (const box of boxes)
      expect(Math.abs(box.width - boxes[0].width), `${width}`).toBeLessThan(1);
    const rows = [...new Set(boxes.map((box) => Math.round(box.top)))];
    const perRow = rows.map(
      (top) => boxes.filter((box) => Math.round(box.top) === top).length,
    );
    expect(perRow, `${width}`).toEqual([3, 2]);
  }
});

test('the HbS map describes the area under its keyboard reticle', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = await hbsReady(page);
  const map = figure.locator('[data-hbs-map]');
  const readout = figure.locator('[data-readout]');
  const idle = await readout.textContent();
  await map.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(readout).not.toHaveText(idle!);
  await expect(readout).toHaveText(
    /Modeled estimate about [\d.]+%|No estimate|[\d,]+ people tested/,
  );
  await page.keyboard.press('Home');
  await expect(readout).not.toHaveText(idle!);
});

test('the HbS map loads when its section opens, plays its entrance and rests painted', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  await expect(figure).not.toHaveAttribute('data-hbs-ready');
  await openSection(page, 'hbs');
  await expect(figure).toHaveAttribute('data-hbs-ready', '');
  // It plays once a reader brings 35% of it into view.
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 4_000,
  });
  const painted = await figure
    .locator('[data-hbs-canvas="surface"]')
    .evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let index = 3; index < data.length; index += 4 * 97)
        if (data[index] > 0) opaque += 1;
      return opaque;
    });
  expect(painted).toBeGreaterThan(100);
});

test('the safeguard tiles play once, then rest', async ({ page }) => {
  await page.goto('/projects/');
  await openSection(page, 'how');
  const figure = page.locator('figure[data-graphic="safeguards"]');
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(figure.locator('li')).toHaveCount(6);
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 5_000,
  });
  const running = await figure.evaluate(
    (element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
  );
  expect(running).toBe(0);
});

test('the Pipeline switches from 6 parts to 3 stages and back', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'how');
  const pipeline = page.locator('figure[data-graphic="pipeline"]');
  await pipeline.scrollIntoViewIfNeeded();
  const toggle = pipeline.getByRole('group', { name: 'Level of detail' });
  await expect(pipeline).toHaveAttribute('data-mode', '6');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveCount(1);
  await toggle.getByRole('button', { name: '3 stages' }).click();
  await expect(pipeline).toHaveAttribute('data-mode', '3');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveCount(1);
  await toggle.getByRole('button', { name: '6 parts' }).click();
  await expect(pipeline).toHaveAttribute('data-mode', '6');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveText('6 parts');
});

test(
  'the HbS readouts and legend hold still while the threshold moves',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/projects/');
    const figure = await hbsReady(page);
    const slider = figure.getByRole('slider');
    const legend = figure.locator('.hbs__legend');
    const tops = new Set<number>();
    // Every stop's count, one line or two, sits in the same reserved box (spec §2.4).
    for (const stop of ['10', '5', '1', '15']) {
      await slider.fill(stop);
      await expect(figure.locator('[data-hbs-threshold]')).toHaveText(
        `${stop}%`,
      );
      tops.add(Math.round((await legend.boundingBox())!.y));
    }
    expect([...tops]).toHaveLength(1);
    // The three genotypes set on one line each, so the triad reads as one column of equals.
    const heights = await figure
      .locator('.triad__choice')
      .evaluateAll((buttons) =>
        buttons.flatMap((button) => [
          Math.round(button.getBoundingClientRect().height),
          Math.round(button.lastElementChild!.getBoundingClientRect().height),
        ]),
      );
    expect(
      new Set(heights.filter((_, i) => i % 2 === 0)).size,
      `${heights}`,
    ).toBe(1);
    expect(
      new Set(heights.filter((_, i) => i % 2 === 1)).size,
      `${heights}`,
    ).toBe(1);
  },
);

// Design review, round 2: the map sat in a hard black well with empty corners, its bottom about
// 140 px below the genotype column. It sits open on the band, like the hero globe, and the
// genotypes, the map and the side panel share one top and one bottom.
test(
  'the HbS map sits open on its band, level with the genotypes and the side panel',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    for (const width of [1440, 1100, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/projects/');
      const figure = await hbsReady(page);
      const map = figure.locator('.hbs__map');
      await expect(map).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(map).toHaveCSS('background-image', 'none');
      const box = (selector: string) =>
        figure
          .locator(selector)
          .first()
          .evaluate((element) => element.getBoundingClientRect().toJSON());
      const [stage, triad, choices] = await Promise.all(
        ['.hbs__map', '.triad', '.triad__choices'].map(box),
      );
      expect(Math.abs(triad.top - stage.top), `${width} top`).toBeLessThan(1.5);
      expect(
        Math.abs(choices.bottom - stage.bottom),
        `${width} bottom`,
      ).toBeLessThan(1.5);
      if (width > 1200) {
        const [tool, legend] = await Promise.all(
          [':scope > .hbs__controls', '.hbs__legend'].map(box),
        );
        expect(
          Math.abs(tool.top - stage.top),
          `${width} panel top`,
        ).toBeLessThan(1.5);
        expect(
          Math.abs(legend.bottom - stage.bottom),
          `${width} panel bottom`,
        ).toBeLessThan(1.5);
      }
    }
  },
);

test(
  'the link row sets in two to four columns',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.goto('/projects/');
    const links = page.locator('.proj-links > li');
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const lefts = await links.evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().left)),
      );
      const columns = new Set(lefts).size;
      expect(columns, `${width} px`).toBeGreaterThanOrEqual(2);
      expect(columns, `${width} px`).toBeLessThanOrEqual(4);
    }
  },
);

test(
  'a tap replays a safeguard tile and lights a roadmap item’s node',
  { tag: '@mobile-chromium' },
  async ({ page }) => {
    await page.goto('/projects/');
    await openSection(page, 'how');
    await openSection(page, 'status');
    const safeguards = page.locator('figure[data-graphic="safeguards"]');
    await safeguards.scrollIntoViewIfNeeded();
    await expect(safeguards).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 5_000,
    });
    const tile = safeguards.locator('.sg-tile').nth(1);
    await tile.tap();
    await expect(tile).toHaveClass(/\bis-replaying\b/);

    const rail = page.locator('figure[data-graphic="status-rail"]');
    await rail.scrollIntoViewIfNeeded();
    const item = rail.locator('[data-item="active-1"]');
    await item.tap();
    // A tap has no hover to end it: the item and its node stay lit until another is tapped.
    await expect(item).toHaveClass(/\bis-lit\b/);
    await expect(rail.locator('[data-node="active-1"]')).toHaveClass(
      /\bis-lit\b/,
    );
    await rail.locator('[data-item="future-0"]').tap();
    await expect(item).not.toHaveClass(/\bis-lit\b/);
    await expect(rail.locator('[data-node="future-0"]')).toHaveClass(
      /\bis-lit\b/,
    );
  },
);

test('the join-up gives each contract field its reason, and replays a record', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'how');
  const figure = page.locator('figure[data-graphic="join-up"]');
  const caption = figure.locator('[data-joinup-caption]');
  await expect(caption).toHaveText(
    'Every observation needs a place, a radius and a count.',
  );
  await figure.locator('[data-field="an"]').first().focus();
  await expect(caption).toHaveText(
    'AN turns a zero into weak evidence, not absence.',
  );
  await page.keyboard.press('Escape');
  await expect(caption).toHaveText(
    'Every observation needs a place, a radius and a count.',
  );
  const record = figure.getByRole('button', { name: /^Paper table/ });
  await record.click();
  await expect(figure.locator('[data-record="paper"]')).toHaveAttribute(
    'data-replay',
    /\d+/,
  );
});

test(
  'on a phone, a contract field’s reason shows beside the field names',
  {
    tag: '@mobile-chromium',
  },
  async ({ page }) => {
    await page.goto('/projects/');
    await openSection(page, 'how');
    const figure = page.locator('figure[data-graphic="join-up"]');
    const head = figure.locator('button[data-field="an"]');
    await head.scrollIntoViewIfNeeded();
    await head.tap();
    await expect(head).toHaveClass(/\bis-lit\b/);
    // The plate is long on a phone: the reason belongs next to the name that was tapped, not in the
    // caption under the last record.
    const gap = await figure.evaluate((element) => {
      const reason = 'AN turns a zero into weak evidence, not absence.';
      const name = element
        .querySelector('button[data-field="an"]')!
        .getBoundingClientRect();
      const shown = [...element.querySelectorAll<HTMLElement>('*')]
        .filter(
          (node) =>
            node.childElementCount === 0 &&
            node.textContent?.trim() === reason &&
            node.checkVisibility({ opacityProperty: true }),
        )
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.top >= 0 && box.bottom <= innerHeight);
      return Math.min(
        ...shown.map((box) =>
          Math.max(0, box.top - name.bottom, name.top - box.bottom),
        ),
      );
    });
    expect(gap).toBeLessThanOrEqual(48);
  },
);

test('the HbS map lets go of its readout when focus leaves it', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = await hbsReady(page);
  const map = figure.locator('[data-hbs-map]');
  const reticle = figure.locator('[data-hbs-reticle]');
  const readout = figure.locator('[data-readout]');
  const idle = await readout.textContent();
  await map.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(reticle).toBeVisible();
  await expect(readout).not.toHaveText(idle!);
  await page.keyboard.press('Tab');
  await expect(map).not.toBeFocused();
  await expect(reticle).toBeHidden();
  await expect(readout).toHaveText(idle!);
});

test(
  'the HbS map redraws only when the pointer reaches something new',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.addInitScript(() => {
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      const counter = window as unknown as { __clears: number };
      counter.__clears = 0;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        counter.__clears += 1;
        return clear.apply(this, args);
      };
    });
    await page.goto('/projects/');
    const figure = await hbsReady(page);
    await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 4_000,
    });
    // Fifteen spots over sea, areas and studs. Arriving at a spot may redraw; further pointer moves
    // that land on the same spot (a slow hand, a high-rate mouse) must not. Before the fix every
    // move redrew both canvases.
    const { arrivals, repeats } = await figure
      .locator('[data-hbs-map]')
      .evaluate((map) => {
        const counter = window as unknown as { __clears: number };
        const box = map.getBoundingClientRect();
        let arrivals = 0;
        const repeats: number[] = [];
        for (const fy of [0.35, 0.5, 0.65])
          for (const fx of [0.3, 0.4, 0.5, 0.6, 0.7]) {
            const move = () =>
              map.dispatchEvent(
                new PointerEvent('pointermove', {
                  bubbles: true,
                  pointerType: 'mouse',
                  clientX: box.left + box.width * fx,
                  clientY: box.top + box.height * fy,
                }),
              );
            const before = counter.__clears;
            move();
            const arrived = counter.__clears;
            arrivals += arrived - before;
            for (let again = 0; again < 4; again += 1) move();
            repeats.push(counter.__clears - arrived);
          }
        return { arrivals, repeats };
      });
    // The counter sees redraws (moving between spots changes what is under the pointer)…
    expect(arrivals).toBeGreaterThan(0);
    // …and staying put draws nothing.
    expect(repeats).toEqual(Array.from({ length: 15 }, () => 0));
  },
);

test('“hemoglobin S” never breaks across two lines', async ({ page }) => {
  await page.goto('/projects/');
  const title = page.locator('#hbs-title');
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const lines = await title.evaluate((heading) => {
      const node = heading.firstChild as Text;
      const at = node.data.indexOf('hemoglobin');
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'hemoglobin S'.length);
      return new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
      ).size;
    });
    expect(lines, `${width} px`).toBe(1);
  }
});

test('the HbS count breaks only between its two clauses', async ({ page }) => {
  await page.goto('/projects/');
  const figure = await hbsReady(page);
  const slider = figure.getByRole('slider');
  const clauses = figure.locator('[data-hbs-count] > span');
  for (const stop of ['5', '1', '10', '15']) {
    await slider.fill(stop);
    await expect(figure.locator('[data-hbs-threshold]')).toHaveText(`${stop}%`);
    await expect(clauses).toHaveCount(2);
    const lines = await clauses.evaluateAll((spans) =>
      spans.map((span) => span.getClientRects().length),
    );
    expect(lines, `${stop}%`).toEqual([1, 1]);
  }
});

// ---------------------------------------------------------------------------------------------
// Round 2 (spec §4.2, §11.2): the index and chapter, people in the HbS readouts, the counts
// figure in people, and the application cards that moved here from Home.

test('the project index opens above the fold, and its links go where they say', async ({
  page,
}, info) => {
  await page.goto('/projects/');
  const index = page.locator('figure[data-graphic="project-index"]');
  const fold = info.project.name === 'mobile-chromium' ? 700 : 640;
  const top = await index.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(top).toBeLessThan(fold);
  await expect(page.locator('h1')).toHaveText('What we’re building');
  await expect(
    index.getByRole('link', { name: 'Open the Atlas' }),
  ).toHaveAttribute('href', '/app/');
  await expect(
    index.getByRole('link', { name: /Share an idea/ }),
  ).toHaveAttribute('target', '_blank');
  await index.getByRole('link', { name: /Read more/ }).click();
  await expect(page).toHaveURL(/#atlas$/);
  await expect(
    page.getByRole('heading', { level: 2, name: 'genomeOS Atlas' }),
  ).toBeInViewport();
});

test('the HbS map reads a survey out in people tested, with its copies as counts', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = await hbsReady(page);
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 4_000,
  });
  const map = figure.locator('[data-hbs-map]');
  await map.scrollIntoViewIfNeeded();
  // A stud's white centre, found on the studs' own canvas.
  const point = await figure
    .locator('[data-hbs-canvas="studs"]')
    .evaluate((canvas: HTMLCanvasElement) => {
      const { width, height } = canvas;
      const { data } = canvas
        .getContext('2d')!
        .getImageData(0, 0, width, height);
      const white = (x: number, y: number) => {
        const at = (y * width + x) * 4;
        return (
          data[at] > 235 &&
          data[at + 1] > 235 &&
          data[at + 2] > 235 &&
          data[at + 3] > 250
        );
      };
      const rect = canvas.getBoundingClientRect();
      for (let y = 3; y < height - 3; y += 2)
        for (let x = 3; x < width - 3; x += 2)
          if (
            [-2, 0, 2].every((dy) =>
              [-2, 0, 2].every((dx) => white(x + dx, y + dy)),
            )
          )
            return {
              x: rect.left + ((x + 0.5) / width) * rect.width,
              y: rect.top + ((y + 0.5) / height) * rect.height,
            };
      return null;
    });
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  const readout = figure.locator('[data-readout]');
  await expect(readout).toHaveText(/[\d,]+ people tested/);
  await expect(readout).not.toHaveText(/alleles/);
  const text = (await readout.textContent()) ?? '';
  if (text.startsWith('Measured survey'))
    expect(text).toMatch(
      /^Measured survey · [\d,]+ people tested; [\d,]+ of their [\d,]+ gene copies carry HbS · Location within ±[\d,]+ km$/,
    );
});

test('the HbS figure says plainly it is simplified, and links the live map', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'hbs');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  await expect(figure.locator('.kit-status-tag')).toHaveCount(0);
  const note = figure.locator('.figure-note');
  await expect(note).toContainText('Simplified from the Atlas’s HbS data.');
  await expect(
    note.getByRole('link', { name: 'See it live in the Atlas' }),
  ).toHaveAttribute('href', '/app/?entity=hbs-rs334&palette=genome');
  await expect(
    figure.getByText('Survey, sized by people tested'),
  ).toBeVisible();
});

/** Survey 2's state, read from the page. */
const surveyTwo = (page: Page) =>
  page.locator('figure[data-graphic="counts"]').evaluate((figure) => {
    const places = [
      ...figure.querySelectorAll('[data-grid="2"] use[data-s]'),
    ].map((use) => use.getAttribute('href'));
    const bar = figure.querySelector<HTMLElement>('[data-bar="2"]')!;
    const range = bar.querySelector('.cf-bar__range')!.getBoundingClientRect();
    const track = bar.getBoundingClientRect();
    return {
      places: places.length,
      tested: places.filter((href) => href?.startsWith('#micro-face-tested-'))
        .length,
      untested: places.filter((href) => href === '#micro-untested').length,
      label: figure.querySelector('[data-count-n]')!.textContent,
      value: bar.querySelector('.cf-bar__value')!.textContent,
      side: bar.dataset.side,
      share: range.right - track.left,
      width: track.width,
      sentence: figure.querySelector('[data-row-sentence="2"]')!.textContent,
    };
  });

test('the counts slider updates survey 2’s people, bar, sentence and spoken value at every stop', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'how');
  const figure = page.locator('figure[data-graphic="counts"]');
  const slider = figure.getByRole('slider', {
    name: 'People tested in survey 2',
  });
  await slider.scrollIntoViewIfNeeded();
  await expect(figure.locator('[data-grid="1"] use')).toHaveCount(206);
  await expect(figure.locator('[data-grid="1"] use.cf-carrier')).toHaveCount(
    58,
  );
  const STOPS = [
    [10, '21.7'],
    [20, '11.7'],
    [50, '4.9'],
    [100, '2.5'],
    [200, '1.2'],
    [500, '0.50'],
  ] as const;
  let previous = Infinity;
  for (const [index, [people, upper]] of STOPS.entries()) {
    await slider.fill(String(index));
    await expect(slider).toHaveAttribute(
      'aria-valuetext',
      `${people} people tested, none carry it, up to ${upper} percent`,
    );
    await expect(figure.locator('output')).toHaveText(
      `0 of ${people}: up to ${upper}% is still plausible.`,
    );
    // Let the bar's 240 ms transition land before measuring it.
    await page.waitForTimeout(400);
    const state = await surveyTwo(page);
    expect(state.places, `${people}`).toBe(500);
    expect(state.tested, `${people}`).toBe(people);
    expect(state.untested, `${people}`).toBe(500 - people);
    expect(state.label).toBe(String(people));
    expect(state.value).toBe(`0–${upper}%`);
    expect(state.side).toBe('right');
    expect(state.sentence).toContain(`none of ${people} people tested`);
    // The bar ends where its upper bound sits on the 0–40% axis, and shrinks as people are added.
    expect(state.share / state.width).toBeCloseTo(
      Math.max(Number(upper) / 40, 2 / state.width),
      1,
    );
    expect(state.share).toBeLessThan(previous);
    previous = state.share;
  }
  // Back to 10: the tested block shrinks again, with no new nodes.
  await slider.fill('0');
  await expect.poll(async () => (await surveyTwo(page)).tested).toBe(10);
  await expect(figure.locator('[data-grid="2"] use')).toHaveCount(500);
});

test('the counts figure’s value labels stay inside it, and nothing scrolls sideways', async ({
  page,
}) => {
  for (const width of [320, 360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/projects/');
    await openSection(page, 'how');
    const figure = page.locator('figure[data-graphic="counts"]');
    const slider = figure.getByRole('slider');
    await slider.scrollIntoViewIfNeeded();
    for (const stop of ['0', '5']) {
      await slider.fill(stop);
      await page.waitForTimeout(350);
      const escapes = await figure.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll('.cf-bar__value')]
          .map((label) => label.getBoundingClientRect())
          .filter(
            (label) =>
              label.left < box.left - 0.5 || label.right > box.right + 0.5,
          ).length;
      });
      expect(escapes, `${width} px, stop ${stop}`).toBe(0);
    }
    // Survey 1's interval ends past 60% of the axis, so its label sits left of the bar.
    await expect(figure.locator('[data-bar="1"]')).toHaveAttribute(
      'data-side',
      'left',
    );
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width} px`).toBe(0);
  }
});

test('the counts figure draws people as micro astronauts, wide and narrow, from the same nodes', async ({
  page,
}, info) => {
  await page.goto('/projects/');
  await openSection(page, 'how');
  const figure = page.locator('figure[data-graphic="counts"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 4_000,
  });
  const layout = await figure.evaluate((element) => {
    const grid = element.querySelector('[data-grid="1"]')!;
    const uses = [...grid.querySelectorAll('use')];
    const boxes = uses.slice(0, 41).map((use) => use.getBoundingClientRect());
    const rows = new Set(
      uses.map((use) => Math.round(use.getBoundingClientRect().top)),
    ).size;
    return {
      perRow: boxes.filter((box) => Math.abs(box.top - boxes[0].top) < 1)
        .length,
      rows,
      glyph: { width: boxes[0].width, height: boxes[0].height },
      gridBottom: grid.getBoundingClientRect().bottom,
      lastBottom: Math.max(
        ...uses.map((use) => use.getBoundingClientRect().bottom),
      ),
    };
  });
  const narrow = info.project.name === 'mobile-chromium';
  expect(layout.perRow).toBe(narrow ? 25 : 40);
  expect(layout.rows).toBe(narrow ? 9 : 6);
  // Big enough to read as a person (the drawn figure, helmet to boots, inside its 16 × 20 glyph):
  // about 14 px tall on a phone, 19 at desktop widths.
  expect(layout.glyph.height).toBeGreaterThanOrEqual(narrow ? 13 : 18);
  expect(layout.glyph.width).toBeGreaterThanOrEqual(narrow ? 8.5 : 12);
  // Every person sits inside the grid's box: none is cut off by the layout switch.
  expect(layout.lastBottom).toBeLessThanOrEqual(layout.gridBottom + 0.5);
  await info.attach(`counts-${info.project.name}`, {
    body: await figure.screenshot(),
    contentType: 'image/png',
  });
});

test('the counts figure rests at once under reduced motion, every person drawn', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/projects/');
  await openSection(page, 'how');
  const figure = page.locator('figure[data-graphic="counts"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
  const hidden = await figure.evaluate(
    (element) =>
      [...element.querySelectorAll('use, .cf-bar__range')].filter(
        (node) => Number(getComputedStyle(node).opacity) < 1,
      ).length,
  );
  expect(hidden).toBe(0);
  // A new stop swaps people at once: no fade runs.
  await figure.getByRole('slider').fill('3');
  const running = await figure.evaluate(
    (element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
  );
  expect(running).toBe(0);
});

test('the counts entrance is a scrubbable scene in the e2e build', async ({
  page,
}) => {
  await page.goto('/projects/');
  // The figure registers once its section has opened and its module has loaded.
  expect(
    await page.evaluate(() => window.__motion?.names() ?? []),
  ).not.toContain('counts');
  await openSection(page, 'how');
  await expect
    .poll(() => page.evaluate(() => window.__motion!.names()))
    .toContain('counts');
  const figure = page.locator('figure[data-graphic="counts"]');
  await figure.scrollIntoViewIfNeeded();
  // At 300 ms survey 1's people are still arriving and its carriers have not lit.
  await page.evaluate(() => window.__motion!.seek('counts', 300));
  const early = await figure.evaluate((element) => ({
    carrier: Number(
      getComputedStyle(element.querySelector('.cf-carrier')!).opacity,
    ),
    bar: getComputedStyle(
      element.querySelector('[data-bar="1"] .cf-bar__range')!,
    ).transform,
  }));
  expect(early.carrier).toBeLessThan(0.5);
  expect(early.bar).toMatch(/matrix\(0,/);
  await page.evaluate(() => window.__motion!.seek('counts', 1600));
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
});

// Hover is a pointer interaction.
test('application cards reveal on scroll and respond to hover @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'uses');

  const card = page.locator('.application-card').first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/is-visible/);
  // Let the reveal slide finish: hovering a moving card makes Playwright re-scroll the page, and
  // the smooth scroll then carries the card out from under the pointer.
  await card.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
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

// Design review, round 3: the glyphs' drawings filled about 60% of their 96 × 64 box, each at its
// own place in it. They are drawn at one scale, at least 96 × 64 and about 128 × 80 a glyph, each
// drawing on its card's text edge, with the title a spacing step under the glyph.
test('the application glyphs read at card scale, on each card’s text edge', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'uses');
  const first = page.locator('.application-card').first();
  await first.scrollIntoViewIfNeeded();
  await expect(first).toHaveClass(/is-visible/);
  const cards = await page.locator('.application-card').evaluateAll((list) =>
    list.map((card) => {
      const svg = card.querySelector<SVGSVGElement>('svg.ag')!;
      const title = card
        .querySelector('.application-card__title')!
        .getBoundingClientRect();
      const glyph = svg.getBoundingClientRect();
      let left = Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const mark of svg.querySelectorAll<SVGGraphicsElement>(
        'path, circle, ellipse, rect, line',
      )) {
        if (mark.closest('defs, pattern, clipPath')) continue;
        const rect = mark.getBoundingClientRect();
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      return {
        width: glyph.width,
        height: glyph.height,
        scale: svg.getScreenCTM()!.a,
        markLeft: left - title.left,
        markTop: top - glyph.top,
        markBottom: glyph.bottom - bottom,
        titleGap: title.top - glyph.bottom,
      };
    }),
  );
  expect(cards).toHaveLength(6);
  for (const [index, card] of cards.entries()) {
    const at = `glyph ${index + 1}`;
    expect(card.width, at).toBeGreaterThanOrEqual(120);
    expect(card.height, at).toBeGreaterThanOrEqual(80);
    expect(card.scale, at).toBeCloseTo(cards[0]!.scale, 3);
    // The drawing starts on the text edge (its stroke may sit a pixel either side).
    expect(Math.abs(card.markLeft), at).toBeLessThan(2);
    expect(card.markTop, at).toBeGreaterThanOrEqual(-0.5);
    expect(card.markBottom, at).toBeGreaterThanOrEqual(-0.5);
    expect(card.titleGap, at).toBeGreaterThanOrEqual(8);
  }
});

// ---------------------------------------------------------------------------------------------
// The owner's restructure (2026-10-15): an overview of the essentials, then the detail in collapsed
// sections a reader opens on demand.

test('the Atlas chapter opens on an overview: the essentials in about 80 words, the pill and three facts', async ({
  page,
}) => {
  await page.goto('/projects/');
  const overview = page.locator('.atlas-ov');
  const { count, text } = await page.evaluate(visibleWords, {
    within: '.atlas-ov',
  });
  expect(count, text).toBeLessThanOrEqual(80);
  await expect(
    overview.getByRole('heading', { level: 2, name: 'genomeOS Atlas' }),
  ).toBeVisible();
  await expect(
    overview.getByRole('link', { name: 'Open the genomeOS Atlas' }),
  ).toHaveAttribute('href', '/app/');
  await expect(overview.locator('data')).toHaveText(['4,392', '6.69M', '2']);
  await expect(overview.getByText('Measured survey')).toBeVisible();
  // "How we count" stays folded: its definition is there for whoever asks.
  const method = overview.locator('details');
  await expect(method).toHaveJSProperty('open', false);
  await method.locator('summary').click();
  await expect(method.getByText(/Recomputed \d{4}-\d{2}-\d{2}/)).toBeVisible();
});

test('every section starts closed: a summary row with an icon, a title, a teaser and a chevron that turns', async ({
  page,
}) => {
  await page.goto('/projects/');
  for (const name of SECTIONS) {
    const section = sectionRow(page, name);
    await expect(section).toHaveJSProperty('open', false);
    const summary = section.locator(':scope > summary');
    await expect(summary.locator('h3')).toBeVisible();
    await expect(summary.locator('.acc__teaser')).toBeVisible();
    await expect(summary.locator('.acc__icon')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(summary.locator('.acc__chevron')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    const box = (await summary.boundingBox())!;
    expect(box.height, name).toBeGreaterThanOrEqual(44);
    // Closed, the section's figures are not drawn at all.
    await expect(section.locator('figure[data-graphic]').first()).toBeHidden();
    const turn = () =>
      summary
        .locator('.acc__chevron')
        .evaluate((chevron) => getComputedStyle(chevron).transform);
    const closed = await turn();
    await openSection(page, name);
    await expect.poll(turn).not.toBe(closed);
  }
});

test('a section opens and closes by click and by keyboard, with a visible focus ring', async ({
  page,
}) => {
  await page.goto('/projects/');
  const section = sectionRow(page, 'uses');
  const summary = section.locator(':scope > summary');
  await summary.click();
  await expect(section).toHaveJSProperty('open', true);
  await expect(
    section.locator('figure[data-graphic="applications"]'),
  ).toBeVisible();
  await summary.click();
  await expect(section).toHaveJSProperty('open', false);

  // From the keyboard: Tab reaches the summary, Enter opens it and Space closes it.
  await sectionRow(page, 'hbs').locator(':scope > summary').focus();
  await page.keyboard.press('Tab');
  await expect(summary).toBeFocused();
  const ring = await summary.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.outlineStyle, style.outlineWidth];
  });
  expect(ring).toEqual(['solid', '2px']);
  await page.keyboard.press('Enter');
  await expect(section).toHaveJSProperty('open', true);
  await page.keyboard.press('Space');
  await expect(section).toHaveJSProperty('open', false);
  // Its expanded state is the summary's own: a disclosure, open or not.
  const snapshot = await summary.ariaSnapshot();
  expect(snapshot).toContain('What it could be used for');
});

for (const [hash, name, target] of [
  ['#status', 'status', '#status'],
  ['#status-title', 'status', '#status-title'],
  ['#hbs', 'hbs', '#hbs'],
  ['#counts', 'how', '#counts'],
  ['#safeguards-title', 'how', '#safeguards-title'],
  ['#applications', 'uses', '#applications'],
] as const)
  test(`a link to ${hash} opens its section and lands on it`, async ({
    page,
  }) => {
    await page.goto(`/projects/${hash}`);
    await expect(sectionRow(page, name)).toHaveJSProperty('open', true);
    for (const other of SECTIONS.filter((section) => section !== name))
      await expect(sectionRow(page, other)).toHaveJSProperty('open', false);
    await expect(page.locator(target).first()).toBeInViewport();
  });

test('a hash change into a closed section opens it, and the old /project/#vision lands on Status', async ({
  page,
}) => {
  await page.goto('/projects/');
  await page.evaluate(() => {
    location.hash = '#pipeline';
  });
  await expect(sectionRow(page, 'how')).toHaveJSProperty('open', true);
  await expect(page.locator('#pipeline-title')).toBeInViewport();

  await page.goto('/project/#vision');
  await expect(page).toHaveURL(/\/projects\/#status$/);
  await expect(sectionRow(page, 'status')).toHaveJSProperty('open', true);
  await expect(page.locator('#status')).toBeInViewport();
});

test('a closed section loads no script and no data; opening one loads its own', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/projects/');
  // Scroll the whole page, as a reader would, without opening anything.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  await page.waitForLoadState('networkidle');
  const lazy =
    /\/_astro\/(section-|pipeline\.|hbs-(region|surveys)\.|hex-kit\.)/;
  expect(requests.filter((url) => lazy.test(url))).toEqual([]);

  await openSection(page, 'hbs');
  await expect(
    page.locator('figure[data-graphic="hbs-threshold"]'),
  ).toHaveAttribute('data-hbs-ready', '');
  expect(requests.some((url) => /section-hbs\./.test(url))).toBe(true);
  expect(
    requests.filter((url) => /hbs-(region|surveys)\.[\w.]+\.bin/.test(url)),
  ).toHaveLength(2);
  expect(requests.some((url) => /section-how\./.test(url))).toBe(false);

  await openSection(page, 'how');
  await expect
    .poll(() => requests.some((url) => /section-how\./.test(url)))
    .toBe(true);
  await expect(page.locator('figure[data-graphic="pipeline"]')).toHaveAttribute(
    'data-pipeline-ready',
    '',
  );
});

test('opening a section plays its figures’ entrances once', async ({
  page,
}) => {
  await page.goto('/projects/');
  const figure = page.locator('figure[data-graphic="join-up"]');
  await figure.evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { __states: string[] }).__states = seen;
    new MutationObserver(() =>
      seen.push((element as HTMLElement).dataset.figureState ?? ''),
    ).observe(element, { attributeFilter: ['data-figure-state'] });
  });
  await openSection(page, 'how');
  // Armed while below the reader's view; it plays once 35% of it is in view.
  await expect(figure).toHaveAttribute('data-figure-state', /armed|playing/);
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 5_000,
  });
  const states = await page.evaluate(
    () => (window as unknown as { __states: string[] }).__states,
  );
  expect(states).toContain('playing');
  // Closed and opened again, it stays at rest: an entrance plays once.
  const summary = sectionRow(page, 'how').locator(':scope > summary');
  await summary.click();
  await summary.click();
  await page.waitForTimeout(600);
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
  const after = await page.evaluate(
    () => (window as unknown as { __states: string[] }).__states.length,
  );
  expect(after).toBe(states.length);
});

test('printing opens every section, and closes again the ones it opened', async ({
  page,
}) => {
  await page.goto('/projects/');
  await openSection(page, 'uses');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  for (const name of SECTIONS)
    await expect(sectionRow(page, name)).toHaveJSProperty('open', true);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(sectionRow(page, 'uses')).toHaveJSProperty('open', true);
  for (const name of ['hbs', 'how', 'status'] as const)
    await expect(sectionRow(page, name)).toHaveJSProperty('open', false);
});

test('axe finds nothing serious with the sections closed, or all open', async ({
  page,
}) => {
  await page.goto('/projects/');
  const blocking = async () =>
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations.filter(({ impact }) =>
      ['serious', 'critical'].includes(impact ?? ''),
    );
  expect(await blocking()).toEqual([]);
  for (const name of SECTIONS) await openSection(page, name);
  // Every entrance at rest, so no text is caught mid-fade.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(
    page.locator('figure[data-graphic="hbs-threshold"]'),
  ).toHaveAttribute('data-hbs-ready', '');
  expect(await blocking()).toEqual([]);
});

test(
  'on a phone the rows run full width, 44 px tall, and nothing scrolls sideways at 320',
  { tag: '@mobile-chromium' },
  async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/projects/');
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
      expect(await overflow(), `${width} px closed`).toBe(0);
      const shell = (await page.locator('.acc-list').boundingBox())!;
      for (const name of SECTIONS) {
        const box = (await sectionRow(page, name)
          .locator(':scope > summary')
          .boundingBox())!;
        expect(Math.abs(box.width - shell.width), name).toBeLessThan(1);
        expect(box.height, name).toBeGreaterThanOrEqual(44);
      }
      for (const name of SECTIONS) await openSection(page, name);
      await page.waitForTimeout(400);
      expect(await overflow(), `${width} px open`).toBe(0);
    }
  },
);
