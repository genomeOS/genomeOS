/**
 * Home page browser checks (site redesign spec §4.1, §9.1; round 2 rulings R2-1, R2-2, R2-12,
 * R2-14; #454). Owned by the Home task. The cross-page suites (word-budget, figures, motion) check
 * the contracts every page shares; these check what is Home's own: the counts slider, the corpus
 * numerals and the application cards. The hero film and the Atlas preview have their own file,
 * marketing-home-hero.spec.ts (round 2 plan T0 step 3).
 */
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const preview = (page: Page) =>
  page.locator('figure[data-graphic="atlas-preview"]');

test('without JavaScript the hero shows its poster and every figure its final state', async ({
  browser,
  isMobile,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: isMobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/');
  const heroPoster = page.locator('.hero-media__poster');
  await expect(heroPoster).toBeVisible();
  await expect(heroPoster).toHaveJSProperty('complete', true);
  await expect(page.locator('.hero-media__video source')).toHaveCount(0);
  await expect(page.locator('[data-video-toggle]')).toBeHidden();

  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  const poster = figure.locator('.hg-poster');
  await expect(poster).toBeVisible();
  await expect
    .poll(() =>
      poster.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  for (const callout of await figure.locator('.hg-callout').all())
    await expect(callout).toBeVisible();
  for (const pin of await figure.locator('.hg-marker__badge').all())
    await expect(pin).toBeVisible();
  // Nothing turns without JavaScript, so there is no Pause and no layer control.
  await expect(figure.locator('[data-spin-toggle]')).toBeHidden();
  await expect(figure.locator('.hg-layers')).toBeHidden();
  // The counts figure, the Pipeline and the corpus bars at rest.
  const bar = page.locator('#why [data-bar="a"] .cf-bar__range');
  expect((await bar.boundingBox())!.width).toBeGreaterThan(10);
  await expect(page.locator('#why output')).toHaveText(
    '0 of 20: up to 11.7% is still plausible.',
  );
  await expect(
    page.locator('#how [data-pipeline="interactive"]'),
  ).not.toHaveClass(/is-armed/);
  await expect(page.locator('.metric data')).toHaveText([
    '4,392',
    '6.69M',
    '2',
  ]);
  for (const segment of await page.locator('.eb-bar__segment').all())
    expect((await segment.boundingBox())!.width).toBeGreaterThanOrEqual(2);
  await context.close();
});

/* ------------------------------------------------------------------ the other figures */

// A statistic never reads as zero on screen (design review, round 1): partly in view, short of
// the 35% that plays an entrance, the tiles already show their totals.
test('the evidence base shows its real totals while only partly in view', async ({
  page,
}) => {
  await page.goto('/');
  const figure = page.locator('figure[data-graphic="evidence-base"]');
  await figure.evaluate((element) => {
    const box = element.getBoundingClientRect();
    window.scrollTo({
      top: window.scrollY + box.top - innerHeight + box.height * 0.2,
      behavior: 'instant',
    });
  });
  await page.waitForTimeout(1200);
  const numbers = page.locator('.metric data');
  expect(
    await numbers.first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top < innerHeight && box.bottom > 0;
    }),
  ).toBe(true);
  expect(await numbers.allTextContents()).toEqual(['4,392', '6.69M', '2']);
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
  // The final values are in the page, as static text.
  await page.locator('.metric').first().scrollIntoViewIfNeeded();
  await expect(page.locator('.metric data')).toHaveText([
    '4,392',
    '6.69M',
    '2',
  ]);
});

// Hover is a pointer interaction.
test('application cards reveal on scroll and respond to hover @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');

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
// own place in it. They are now drawn at one scale, at least 96 × 64 and about 128 × 80 a glyph,
// each drawing on its card's text edge, with the title a spacing step under the glyph.
test('the application glyphs read at card scale, on each card’s text edge', async ({
  page,
}) => {
  await page.goto('/');
  const first = page.locator('.application-card').first();
  await first.scrollIntoViewIfNeeded();
  await expect(first).toHaveClass(/is-visible/);
  const cards = await page.locator('.application-card').evaluateAll((list) =>
    list.map((card) => {
      const svg = card.querySelector<SVGSVGElement>('svg.ag')!;
      const title = card.querySelector('h3')!.getBoundingClientRect();
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

test('on a phone the counts axis heads the bar it scales @mobile-chromium', async ({
  page,
}) => {
  await page.goto('/');
  const why = page.locator('#why');
  const grid = (await why
    .locator('[data-row="a"] .cf-row__grid')
    .boundingBox())!;
  const axis = (await why.locator('.cf-axis').boundingBox())!;
  const bar = (await why.locator('[data-bar="a"]').boundingBox())!;
  // Label A, grid A, then the axis directly over bar A.
  expect(axis.y).toBeGreaterThanOrEqual(grid.y + grid.height);
  const gap = bar.y - (axis.y + axis.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(16);
});

test('on a phone the vision teaser reads heading, figure, then its link @mobile-chromium', async ({
  page,
}) => {
  await page.goto('/');
  const vision = page.locator('#vision');
  const order = await Promise.all(
    ['h2', 'figure[data-graphic="vision"]', '.home-vision__link'].map(
      (selector) =>
        vision
          .locator(selector)
          .evaluate((element) => element.getBoundingClientRect().top),
    ),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

// Design review, round 2: each zoom square sits on the content it magnifies, inside its frame, and
// its wedge opens from it to the next frame, as on Project's ladder; at every width.
test('the vision teaser’s zoom squares sit on what they magnify, and its wedges open from them', async ({
  page,
}) => {
  await page.goto('/');
  const figure = page.locator('figure[data-graphic="vision"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
  const frames = await figure.evaluate((element) => {
    const svg = [...element.querySelectorAll('svg.vs-svg')].find((candidate) =>
      candidate.checkVisibility(),
    )!;
    const box = (node: Element | null) =>
      node ? node.getBoundingClientRect().toJSON() : null;
    // Where each wedge line starts, on screen.
    const starts = (index: number) =>
      [
        ...svg.querySelectorAll<SVGLineElement>(
          `[data-wedge="${index + 1}"] line`,
        ),
      ].map((line) => {
        const point = new DOMPoint(
          line.x1.baseVal.value,
          line.y1.baseVal.value,
        ).matrixTransform(line.getScreenCTM()!);
        return [point.x, point.y];
      });
    return [...svg.querySelectorAll('[data-frame]')].map((frame, index) => ({
      border: box(frame.querySelector('.ladder__border')),
      zoom: box(frame.querySelector('.ladder__zoom')),
      starts: starts(index),
    }));
  });
  expect(frames).toHaveLength(4);
  for (const [index, { border, zoom, starts }] of frames
    .slice(0, 3)
    .entries()) {
    expect(zoom, `frame ${index + 1}`).not.toBeNull();
    const centre =
      (zoom!.left + zoom!.width / 2 - border!.left) / border!.width;
    // On the content, not on the frame's edge.
    expect(centre, `frame ${index + 1} zoom`).toBeGreaterThan(0.15);
    expect(centre, `frame ${index + 1} zoom`).toBeLessThan(0.85);
    expect(zoom!.right, `frame ${index + 1} zoom`).toBeLessThan(
      border!.right - 4,
    );
    // Both wedge lines start at the zoom square, inside the frame.
    expect(starts, `frame ${index + 1} wedge`).toHaveLength(2);
    for (const [x, y] of starts) {
      expect(x, `frame ${index + 1} wedge`).toBeGreaterThanOrEqual(
        zoom!.left - 1.5,
      );
      expect(x, `frame ${index + 1} wedge`).toBeLessThanOrEqual(
        zoom!.right + 1.5,
      );
      expect(y, `frame ${index + 1} wedge`).toBeGreaterThanOrEqual(
        zoom!.top - 1.5,
      );
      expect(y, `frame ${index + 1} wedge`).toBeLessThanOrEqual(
        zoom!.bottom + 1.5,
      );
    }
  }
});

// The counts figure reads as sample size at rest (design review, round 1): row B's reserved room
// is a faint ghost grid of untested alleles that the slider fills, and the grids span the figure.
test('the counts grids span the figure, and row B’s room is alleles not yet tested', async ({
  page,
}) => {
  await page.goto('/');
  const why = page.locator('#why');
  const figure = why.locator('figure[data-graphic="counts"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
  const stage = (await figure.locator('[data-figure-stage]').boundingBox())!;
  for (const row of ['a', 'b']) {
    const grid = figure.locator(`[data-grid="${row}"]:visible`);
    const box = (await grid.boundingBox())!;
    expect(box.width, `grid ${row}`).toBeGreaterThanOrEqual(stage.width * 0.9);
  }
  const ghost = figure.locator('[data-grid="b"]:visible [data-ghost]');
  await expect(ghost).toHaveCount(1);
  const tested = figure.locator('[data-grid="b"]:visible [data-squares]');
  const height = async (locator: typeof ghost) =>
    (await locator.boundingBox())?.height ?? 0;
  const room = await height(ghost);
  // At the default stop, 20 of the 2,000 squares are tested: one short row.
  expect(await height(tested.first())).toBe(0);
  expect(await height(tested.nth(1))).toBeLessThan(room / 10);
  await why.getByRole('slider', { name: 'Alleles tested in B' }).focus();
  await page.keyboard.press('End');
  await expect
    .poll(async () => Math.abs((await height(tested.first())) - room))
    .toBeLessThan(1);
});

/**
 * The share of a screenshot's pixels that stand out from `ground` at 3:1 or more (WCAG 1.4.11),
 * decoded in a blank page so the page under test is untouched.
 */
async function standOutShare(
  page: Page,
  png: Buffer,
  ground: string,
): Promise<number> {
  const scratch = await page.context().newPage();
  try {
    return await scratch.evaluate(
      async ({ data, ground }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height);
        const channel = (value: number) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (r: number, g: number, b: number) =>
          0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        const [r, g, b] = ground.match(/\d+/g)!.map(Number);
        const base = luminance(r, g, b);
        let marked = 0;
        for (let i = 0; i < pixels.data.length; i += 4) {
          const value = luminance(
            pixels.data[i],
            pixels.data[i + 1],
            pixels.data[i + 2],
          );
          const ratio =
            (Math.max(value, base) + 0.05) / (Math.min(value, base) + 0.05);
          if (ratio >= 3) marked += 1;
        }
        return marked / (pixels.data.length / 4);
      },
      { data: png.toString('base64'), ground },
    );
  } finally {
    await scratch.close();
  }
}

// Design review, round 2: tested non-carriers drew at about 1.25:1 on the orbit band, the same as
// the room for untested alleles, so row B read as one empty textured block and the slider visibly
// moved only the 2 px bar. Tested squares now stand out at 3:1 or more; untested room does not.
test('row B’s tested alleles stand out from the band, and the slider visibly grows them', async ({
  page,
}) => {
  await page.goto('/');
  const why = page.locator('#why');
  const figure = why.locator('figure[data-graphic="counts"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-figure-state', 'rest');
  const ground = await why.evaluate(
    (band) => getComputedStyle(band).backgroundColor,
  );
  const grid = figure.locator('[data-grid="b"]:visible');
  const { columns, pitch, size } = await grid.evaluate((svg) => ({
    columns: Number((svg as SVGSVGElement).dataset.columns),
    pitch: Number((svg as SVGSVGElement).dataset.pitch),
    size: Number((svg as SVGSVGElement).dataset.size),
  }));
  const rows = Math.ceil(2000 / columns);

  // 20 of 2,000: each tested square shows (at least a quarter of its cell stands out), and the
  // untested room adds nothing.
  const at20 = await standOutShare(page, await grid.screenshot(), ground);
  const cells = columns * rows;
  expect(at20, 'twenty tested squares').toBeGreaterThanOrEqual(
    (20 * 0.25) / cells,
  );
  expect(at20, 'the untested room stays quiet').toBeLessThan(
    (20 * 1.2) / cells,
  );

  await why.getByRole('slider', { name: 'Alleles tested in B' }).focus();
  await page.keyboard.press('End');
  await expect(why.locator('[data-count-n]')).toHaveText('2,000');
  await page.waitForTimeout(400); // the 240 ms grid tween
  const at2000 = await standOutShare(page, await grid.screenshot(), ground);
  // All 2,000 tested: most of every square's area stands out (edges blend into the band).
  expect(at2000, 'two thousand tested squares').toBeGreaterThan(
    0.6 * (size / pitch) ** 2,
  );
  expect(at2000 / at20).toBeGreaterThan(40);
});

test('the counts slider moves bar B and its sentence together, both in view on a phone', async ({
  page,
}) => {
  await page.goto('/');
  const why = page.locator('#why');
  const slider = why.getByRole('slider', { name: 'Alleles tested in B' });
  const output = why.locator('output');
  const bar = why.locator('[data-bar="b"] .cf-bar__range');
  await slider.scrollIntoViewIfNeeded();
  // Measure bar B once the figure's entrance has finished growing it.
  await expect(why.locator('figure[data-graphic="counts"]')).toHaveAttribute(
    'data-figure-state',
    'rest',
  );
  await expect(output).toHaveText('0 of 20: up to 11.7% is still plausible.');
  const wide = (await bar.boundingBox())!.width;

  await slider.focus();
  await page.keyboard.press('End');
  await expect(output).toHaveText(
    '0 of 2,000: up to 0.13% is still plausible.',
  );
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    '2,000 alleles tested, none carry it, up to 0.13 percent',
  );
  await expect(why.locator('[data-count-n]')).toHaveText('2,000');
  await expect
    .poll(async () => (await bar.boundingBox())!.width)
    .toBeLessThan(wide / 4);
  // Never nothing: a 2 px bar at least.
  expect((await bar.boundingBox())!.width).toBeGreaterThanOrEqual(1.9);

  // The control and the bar it moves are on screen together.
  const viewport = page.viewportSize()!;
  for (const target of [slider, output, bar]) {
    const box = (await target.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
});

// The closing band sits on the calls-to-action grid: 2 × 2 cards (never 3 + 1) until there is room
// for one row of four at 80rem, and the field ends where the last card ends, inside that card's
// column (design review, rounds 1 and 2). The field is small: about half its round-1 size.
test('the open field lines up with the calls to action below it @desktop-chromium', async ({
  page,
}) => {
  for (const width of [960, 1024, 1180, 1200, 1279, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const field = (await page.locator('.of-stage svg').boundingBox())!;
    const ctas = await page
      .locator('.home-open__routes .github-cta')
      .evaluateAll((links) =>
        links.map((link) => link.getBoundingClientRect().toJSON()),
      );
    expect(ctas, `${width}`).toHaveLength(4);
    const rows = new Set(ctas.map((cta) => Math.round(cta.top))).size;
    expect(rows, `${width} rows`).toBe(width >= 1280 ? 1 : 2);
    const last = ctas[3];
    expect(
      Math.abs(field.x + field.width - last.right),
      `${width} right`,
    ).toBeLessThan(1.5);
    expect(field.x, `${width} left`).toBeGreaterThanOrEqual(last.left - 1.5);
    expect(field.width, `${width} size`).toBeLessThanOrEqual(360);
  }
  // One range style on the site: Home's counts slider is Project's.
  await expect(
    page.getByRole('slider', { name: 'Alleles tested in B' }),
  ).toHaveCSS('appearance', 'none');
});
