/**
 * Home page browser checks (site redesign spec §4.1, §9.1; #454). Owned by the Home task. The
 * cross-page suites (word-budget, figures, motion) check the contracts every page shares; these
 * check what is Home's own: the hero globe's interactions, the counts slider, the corpus numerals
 * and the application cards.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

declare global {
  interface Window {
    __frames?: { requested: number; pending: Set<number> };
  }
}

/** Count requestAnimationFrame calls and the frames still pending. */
async function instrumentFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames = { requested: 0, pending: new Set<number>() };
    window.__frames = frames;
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      frames.requested += 1;
      const id = request((time) => {
        frames.pending.delete(id);
        callback(time);
      });
      frames.pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frames.pending.delete(id);
      cancel(id);
    };
  });
}

const frames = (page: Page) =>
  page.evaluate(() => ({
    requested: window.__frames?.requested ?? 0,
    pending: window.__frames?.pending.size ?? 0,
  }));

const hero = (page: Page) => page.locator('figure[data-graphic="hero-globe"]');
const readout = (page: Page) => hero(page).locator('[data-readout-text]');

/** The hero once its data is decoded and the canvas has replaced the poster. */
async function liveHero(page: Page): Promise<Locator> {
  const figure = hero(page);
  await expect(figure).toHaveAttribute('data-live', '');
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 8_000,
  });
  return figure;
}

/** Screen position of a callout's target at rest, from its disc coordinates. */
async function calloutTarget(
  page: Page,
  kind: 'survey' | 'modeled' | 'unknown',
): Promise<{ x: number; y: number }> {
  return page.evaluate((name) => {
    const figure = document.querySelector('[data-graphic="hero-globe"]')!;
    const globe = figure.querySelector('.hg-globe')!.getBoundingClientRect();
    const callout = figure.querySelector<HTMLElement>(
      `[data-target="${name}"]`,
    )!;
    const radius = globe.width / 2 / 1.04;
    return {
      x: globe.left + globe.width / 2 + Number(callout.dataset.discX) * radius,
      y: globe.top + globe.height / 2 + Number(callout.dataset.discY) * radius,
    };
  }, kind);
}

test('reduced motion: the hero rests at once, lit, and schedules no frames', async ({
  page,
}) => {
  await instrumentFrames(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const figure = await liveHero(page);
  // The most informative state: every step and callout lit.
  await expect(figure.locator('.hg-step.is-off')).toHaveCount(0);
  await expect(figure.locator('.hg-callout.is-off')).toHaveCount(0);
  await page.waitForTimeout(1200);
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === 'running')
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return !(
            target instanceof Element && target.closest('.launch-atlas-cta')
          );
        }).length,
  );
  expect(running).toBe(0);
  const before = await frames(page);
  await page.waitForTimeout(1000);
  const after = await frames(page);
  expect(after.requested - before.requested).toBe(0);
  expect(after.pending).toBe(0);

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

test('the hero plays once, then stops scheduling frames', async ({ page }) => {
  await instrumentFrames(page);
  await page.goto('/');
  const figure = await liveHero(page);
  await expect(figure.locator('.hg-step.is-off')).toHaveCount(0);
  await expect(figure.locator('.hg-callout.is-off')).toHaveCount(0);
  await page.waitForTimeout(400);
  const before = await frames(page);
  await page.waitForTimeout(1000);
  const after = await frames(page);
  expect(after.requested - before.requested).toBe(0);
  expect(after.pending).toBe(0);
});

test('after a deep link, the hero is lit and at rest when scrolled back to', async ({
  page,
}) => {
  // Opened further down, the hero may arm off screen (or play before the jump): either way,
  // returning to it must never leave it blank. The evidence base, which always starts off screen,
  // checks the same entrance driver in the metric digits test.
  await page.goto('/#metrics-title');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const figure = await liveHero(page);
  await expect(figure.locator('.hg-step.is-off')).toHaveCount(0);
  await expect(figure.locator('.hg-callout.is-off')).toHaveCount(0);
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
  // The final values are in the page, and the count-up ends on them.
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

test('the hero stage opens in the first phone viewport @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const top = await hero(page)
    .locator('[data-figure-stage]')
    .evaluate((stage) => stage.getBoundingClientRect().top);
  expect(top).toBeLessThan(844);
  // Kicker, H1, figure, then the lede and the calls to action.
  const order = await page.evaluate(() =>
    [
      '.home-hero__kicker',
      'h1',
      '[data-graphic="hero-globe"]',
      '.home-hero__lede',
    ].map(
      (selector) =>
        document.querySelector(selector)!.getBoundingClientRect().top,
    ),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The hero at rest: its disc (the globe box), stage, step buttons and visible callout boxes. */
function heroGeometry(page: Page) {
  return page.evaluate(() => {
    const figure = document.querySelector('[data-graphic="hero-globe"]')!;
    const box = (element: Element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const globe = figure.querySelector('.hg-globe')!.getBoundingClientRect();
    return {
      // The globe box is the disc plus 4%, room for the limb studs' rings.
      disc: {
        x: globe.left + globe.width / 2,
        y: globe.top + globe.height / 2,
        r: globe.width / 2,
      },
      stage: box(figure.querySelector('[data-figure-stage]')!),
      steps: [...figure.querySelectorAll('.hg-step button')].map(box),
      callouts: [...figure.querySelectorAll<HTMLElement>('.hg-callout')]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => ({
          kind: element.dataset.callout!,
          ...box(element),
        })),
    };
  });
}

test('the callouts sit in the stage margins, clear of the disc and its studs @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  // From the narrowest wide form (one column, the figure just over 33rem) through the split.
  for (const [width, height] of [
    [650, 900],
    [768, 1024],
    [1100, 900],
    [1152, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    const { disc, stage, steps, callouts } = await heroGeometry(page);
    expect(callouts, `${width}×${height}`).toHaveLength(3);
    for (const callout of callouts) {
      const where = `${callout.kind} callout at ${width}×${height}`;
      // The box's nearest point to the disc's centre is outside the globe box: no stud, cell or
      // limb is ever under a callout.
      const x = Math.max(callout.left, Math.min(disc.x, callout.right));
      const y = Math.max(callout.top, Math.min(disc.y, callout.bottom));
      expect(Math.hypot(x - disc.x, y - disc.y), where).toBeGreaterThanOrEqual(
        disc.r,
      );
      expect(callout.left, where).toBeGreaterThanOrEqual(stage.left - 0.5);
      expect(callout.right, where).toBeLessThanOrEqual(stage.right + 0.5);
      expect(callout.top, where).toBeGreaterThanOrEqual(stage.top - 0.5);
      expect(callout.bottom, where).toBeLessThanOrEqual(stage.bottom + 0.5);
      for (const other of [
        ...steps,
        ...callouts.filter((entry) => entry !== callout),
      ])
        expect(overlaps(callout, other), where).toBe(false);
    }
  }
});

test('the hero shows its calls to action in the first view on laptops @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  // The split: the text starts level with the figure, so it never sinks below the fold.
  for (const [width, height] of [
    [1152, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    const where = `${width}×${height}`;
    const kicker = (await page.locator('.home-hero__kicker').boundingBox())!;
    const figure = (await hero(page).boundingBox())!;
    const actions = (await page.locator('.home-hero__actions').boundingBox())!;
    expect(kicker.x + kicker.width, where).toBeLessThan(figure.x);
    expect(Math.abs(kicker.y - figure.y), where).toBeLessThan(2);
    expect(actions.y + actions.height, where).toBeLessThanOrEqual(height);
  }
  // At 1440×900 the stage, its callouts and its step row are above the fold too (spec §4.1).
  await page.setViewportSize({ width: 1440, height: 900 });
  const stage = (await hero(page)
    .locator('[data-figure-stage]')
    .boundingBox())!;
  expect(stage.y + stage.height).toBeLessThanOrEqual(900);

  // Narrower screens stack as on a tablet: kicker, H1, the figure (in its first view), the lede.
  for (const [width, height] of [
    [1024, 768],
    [1100, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const order = await page.evaluate(() =>
      [
        '.home-hero__kicker',
        'h1',
        '[data-graphic="hero-globe"]',
        '.home-hero__lede',
      ].map(
        (selector) =>
          document.querySelector(selector)!.getBoundingClientRect().top,
      ),
    );
    expect(
      [...order].sort((a, b) => a - b),
      `${width}×${height}`,
    ).toEqual(order);
    const top = await hero(page)
      .locator('[data-figure-stage]')
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(top, `${width}×${height}`).toBeLessThan(height);
  }
});

test('on a phone the layer row spans the figure and Reset view never moves the globe @mobile-chromium', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  const toolbar = (await figure.locator('.kit-figure__toolbar').boundingBox())!;
  const layers = (await figure
    .getByRole('group', { name: 'Layer' })
    .boundingBox())!;
  expect(layers.width).toBeGreaterThanOrEqual(toolbar.width - 1);

  const globe = figure.locator('.hg-globe');
  await globe.scrollIntoViewIfNeeded();
  const stageTop = () =>
    figure
      .locator('[data-figure-stage]')
      .evaluate((stage) => stage.getBoundingClientRect().top + window.scrollY);
  const before = await stageTop();
  // A real touch drag, sideways across the globe (vertical drags scroll the page: pan-y).
  const box = (await globe.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width * 0.25;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 8; step += 1)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + step * 16, y }],
    });
  const reset = figure.getByRole('button', { name: 'Reset view' });
  // Mid-gesture: Reset view is offered, and the globe under the finger has not moved down.
  await expect(reset).toBeVisible();
  expect(await stageTop()).toBeCloseTo(before, 0);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(figure).toHaveAttribute('data-view', 'moved');
  expect(await stageTop()).toBeCloseTo(before, 0);

  await reset.click();
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(reset).toBeHidden();
  expect(await stageTop()).toBeCloseTo(before, 0);
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
  // The 2×2 grid has no zoom wedges, so no frame marks a region for one.
  for (const focus of await vision.locator('.vs-frame__focus').all())
    await expect(focus).toBeHidden();
});

test('the layer control has one pressed layer and swaps the legend', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  await expect(readout(page)).toBeVisible();
  await expect(readout(page)).toHaveText('Drag to turn. Tap to inspect.');
  const layers = figure.getByRole('group', { name: 'Layer' });
  const pressed = layers.locator('[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveText('Modeled');
  await expect(figure.locator('figcaption')).toContainText(
    'Fades away from surveys',
  );

  await layers.getByRole('button', { name: 'Evidence' }).click();
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveText('Evidence');
  const evidence = figure.locator('[data-legend="evidence"]');
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText('within 170 km');
  await expect(figure.locator('[data-legend="modeled"]')).toBeHidden();

  await layers.getByRole('button', { name: 'Measured' }).click();
  await expect(pressed).toHaveText('Measured');
  await expect(figure.locator('[data-legend="measured"]')).toContainText(
    'Model grid, no values drawn',
  );
});

/** The callouts (wide form) or numbered markers (compact form) the current layout draws. */
const restMarks = (page: Page) =>
  hero(page).evaluate((figure) =>
    [...figure.querySelectorAll<HTMLElement>('.hg-callout, .hg-marker')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => {
        const style = getComputedStyle(element);
        return `${style.visibility} ${style.opacity}`;
      }),
  );

// Forced colours hide the canvas and show the poster, the Modeled rest view (spec §2.2), so the
// figure is its poster: nothing turns or switches a hidden canvas under a legend it no longer fits.
test('in forced colours the hero is its poster: the modeled legend, and nothing turns it', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  const figure = hero(page);
  await expect(figure).toHaveAttribute('data-mode', 'poster');
  await expect(figure.locator('.hg-poster')).toBeVisible();
  await expect(figure.locator('.hg-layers')).toBeHidden();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  for (const other of ['measured', 'evidence'])
    await expect(figure.locator(`[data-legend="${other}"]`)).toBeHidden();

  // Keys read the poster's centre and never turn the hidden canvas.
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(readout(page)).not.toHaveText('Drag to turn. Tap to inspect.');
  const centre = await readout(page).textContent();
  for (let press = 0; press < 5; press += 1)
    await page.keyboard.press('ArrowRight');
  await expect(readout(page)).toHaveText(centre!);
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(figure.locator('.hg-reset')).toBeHidden();
  await expect
    .poll(() => restMarks(page))
    .toEqual(['visible 1', 'visible 1', 'visible 1']);
  // The reticle is drawn in system colours, so forced colours keep it.
  const reticle = figure.locator('.hg-reticle');
  await expect(reticle).toBeVisible();
  expect(
    await reticle.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    ),
  ).toContain('gradient');
});

test('turning forced colours on mid-visit returns the hero to its poster, and off to the live globe', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  // What the centre reticle reads at rest, which is the poster's view.
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  await page.keyboard.press('Home');
  await expect(readout(page)).not.toHaveText('Drag to turn. Tap to inspect.');
  const restCentre = await readout(page).textContent();

  const layers = figure.locator('.hg-layers');
  await layers.getByRole('button', { name: 'Evidence' }).click();
  await globe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await expect(readout(page)).not.toHaveText(restCentre!);

  await page.emulateMedia({ forcedColors: 'active' });
  await expect(figure).toHaveAttribute('data-mode', 'poster');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(layers).toBeHidden();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(figure.locator('[data-legend="evidence"]')).toBeHidden();
  await expect(layers.locator('[aria-pressed="true"]')).toHaveText('Modeled');
  // The reticle now reads the centre of the view the poster shows.
  await expect(readout(page)).toHaveText(restCentre!);

  await page.emulateMedia({ forcedColors: 'none' });
  await expect(figure).not.toHaveAttribute('data-mode', 'poster');
  await expect(figure).toHaveAttribute('data-live', '');
  await expect(layers).toBeVisible();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
});

// The canvas never prints; the poster (Modeled, at rest) does, so the print carries its legend and
// callouts, never the last layer's legend or a readout from a turned view.
test('printing after a layer switch and a turn shows the poster’s own legend and callouts', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  await figure
    .getByRole('group', { name: 'Layer' })
    .getByRole('button', { name: 'Evidence' })
    .click();
  await figure.locator('.hg-globe').focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');

  await page.emulateMedia({ media: 'print' });
  await expect(figure.locator('.hg-poster')).toBeVisible();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(figure.locator('[data-legend="evidence"]')).toBeHidden();
  await expect(figure.locator('.hg-readout')).toBeHidden();
  await expect
    .poll(() => restMarks(page))
    .toEqual(['visible 1', 'visible 1', 'visible 1']);
});

test('the steps pin a measured survey and a hatched area in the readout', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  await figure.locator('.hg-step button').nth(0).click();
  await expect(readout(page)).toContainText(' of ');
  await expect(readout(page)).toContainText('alleles');
  await expect(readout(page)).toContainText('Measured survey');

  await figure.locator('.hg-step button').nth(1).click();
  await expect(readout(page)).toContainText('Modeled estimate about');
  await expect(readout(page)).toContainText('95% credible range');

  await figure.locator('.hg-step button').nth(2).click();
  await expect(readout(page)).toContainText('No estimate');
});

// Hover is a pointer interaction; taps are covered below.
test('pointing at a stud reads counts; pointing at a hatched area reads no estimate @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  await liveHero(page);
  const survey = await calloutTarget(page, 'survey');
  await page.mouse.move(survey.x, survey.y);
  await expect(readout(page)).toContainText(' of ');
  await expect(readout(page)).toContainText('alleles');

  const unknown = await calloutTarget(page, 'unknown');
  await page.mouse.move(unknown.x, unknown.y);
  await expect(readout(page)).toContainText('No estimate');
});

test('a tap pins what is under it @mobile-chromium', async ({ page }) => {
  await page.goto('/');
  await liveHero(page);
  const unknown = await calloutTarget(page, 'unknown');
  await page.touchscreen.tap(unknown.x, unknown.y);
  await expect(readout(page)).toContainText('No estimate');
});

// A mouse drag; the phone's touch drag is tested on its own below.
test('dragging turns the globe: the callouts step aside until Reset view @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  const globe = figure.locator('.hg-globe');
  const box = (await globe.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await expect(readout(page)).not.toHaveText('Drag to turn. Tap to inspect.');
  const before = await readout(page).textContent();

  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 4 });
  await page.mouse.move(centre.x + 140, centre.y, { steps: 4 });
  await page.mouse.up();
  await expect(figure).toHaveAttribute('data-view', 'moved');
  const reset = figure.getByRole('button', { name: 'Reset view' });
  await expect(reset).toBeVisible();
  await expect(figure.locator('.hg-callout').first()).toHaveCSS('opacity', '0');
  await page.waitForTimeout(1100); // inertia, at most 1 s
  await page.mouse.move(centre.x, centre.y);
  await expect(readout(page)).not.toHaveText(before!);

  await reset.click();
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(reset).toBeHidden();
  await expect(figure.locator('.hg-callout').first()).toHaveCSS('opacity', '1');
});

test('arrow keys turn the focused globe and the readout follows its centre', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure.locator('.hg-reticle')).toBeVisible();
  await expect(readout(page)).toContainText(/estimate/i);
  const first = await readout(page).textContent();
  await page.keyboard.press('ArrowRight');
  await expect(readout(page)).not.toHaveText(first!);
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-view', 'rest');
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

test('without JavaScript every figure shows its final state', async ({
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
  const figure = hero(page);
  const poster = figure.locator('.hg-poster');
  await expect(poster).toBeVisible();
  await expect(poster).toHaveJSProperty('complete', true);
  expect(
    await poster.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(figure.locator('.hg-step')).toHaveCount(3);
  for (const step of await figure.locator('.hg-step').all())
    await expect(step).toBeVisible();
  // Nothing turns or inspects without JavaScript, so the readout offers no hint.
  await expect(figure.locator('[data-readout-text]')).toBeHidden();
  if (!isMobile)
    for (const callout of await figure.locator('.hg-callout').all())
      await expect(callout).toBeVisible();
  else
    for (const marker of await figure.locator('.hg-marker__badge').all())
      await expect(marker).toBeVisible();
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

test('Home loads its own figure data and no decorative raster', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto('/');
  await liveHero(page);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await page.waitForTimeout(500);
  expect(requested.some((url) => /hbs-globe\.[0-9a-f]+.*\.bin/.test(url))).toBe(
    true,
  );
  expect(
    requested.some((url) => /hbs-surveys\.[0-9a-f]+.*\.bin/.test(url)),
  ).toBe(true);
  for (const url of requested) {
    expect(url).not.toMatch(/vision-earth|genomeos-banner|hbs-region/);
    expect(url).not.toMatch(/cesium|react/i);
  }
});
