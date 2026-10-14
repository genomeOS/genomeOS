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

test('application cards reveal on scroll and respond to hover', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover movement is a pointer interaction');
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

test('the layer control has one pressed layer and swaps the legend', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await liveHero(page);
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

test('pointing at a stud reads counts; pointing at a hatched area reads no estimate', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover is a pointer interaction; taps are covered below');
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

test('dragging turns the globe: the callouts step aside until Reset view', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'a mouse drag; touch drags pan the page vertically');
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
