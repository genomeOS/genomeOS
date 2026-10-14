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

declare global {
  interface Window {
    __heroPaints?: {
      state: string | null;
      poster: boolean;
      marks: boolean[];
    }[];
  }
}

// Spec §2.7 rule 5: above the fold never flashes. The server renders the hero at rest (poster,
// callouts, lit steps); with motion allowed the figure must arm before its first paint, so the
// rest state never shows and then blanks for the entrance (design review, round 1).
test('the hero never paints its rest state and then blanks it for the entrance', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const paints: NonNullable<Window['__heroPaints']> = [];
    window.__heroPaints = paints;
    const shown = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility === 'visible' &&
        Number(style.opacity) > 0.05
      );
    };
    // Every frame, before it paints: what the hero is about to show.
    const sample = () => {
      const figure = document.querySelector('[data-graphic="hero-globe"]');
      const poster = figure?.querySelector<HTMLImageElement>('.hg-poster');
      if (figure && poster && figure.querySelector('.hg-steps'))
        paints.push({
          state: figure.getAttribute('data-figure-state'),
          poster: poster.complete && poster.naturalWidth > 0 && shown(poster),
          marks: [
            ...figure.querySelectorAll<HTMLElement>('.hg-callout, .hg-marker'),
          ]
            .filter((element) => getComputedStyle(element).display !== 'none')
            .map(shown),
        });
      if (performance.now() < 6000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/');
  await expect(hero(page)).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 8_000,
  });
  await page.waitForTimeout(200);
  const paints = await page.evaluate(() => window.__heroPaints ?? []);
  expect(paints.length).toBeGreaterThan(5);
  // A callout (or marker), once painted, stays painted.
  for (let index = 0; index < paints[0].marks.length; index += 1) {
    const shown = paints.map((paint) => paint.marks[index]);
    const first = shown.indexOf(true);
    if (first >= 0)
      expect(shown.slice(first).every(Boolean), `callout ${index + 1}`).toBe(
        true,
      );
  }
  // Once the poster (the rest view) has painted, the entrance never starts after it.
  const poster = paints.findIndex((paint) => paint.poster);
  if (poster >= 0)
    expect(
      paints
        .slice(poster)
        .some((paint) => paint.state === 'armed' || paint.state === 'playing'),
    ).toBe(false);
});

// WCAG 2.4.3: the calls to action are read and reached before the figure's own controls.
test('the hero’s calls to action come right after its heading in the focus order', async ({
  page,
}) => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.locator('h1').evaluate((title: HTMLElement) => {
      title.tabIndex = -1;
      title.focus();
    });
    await page.keyboard.press('Tab');
    await expect(
      page.locator('.home-hero__actions .button-link').nth(0),
      `${width}`,
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.locator('.home-hero__actions .button-link').nth(1),
      `${width}`,
    ).toBeFocused();
    await page.keyboard.press('Tab');
    // Then the figure: its first control, never something above the calls to action.
    const next = await page.evaluate(() =>
      document.activeElement?.closest('[data-graphic="hero-globe"]')
        ? 'figure'
        : document.activeElement?.outerHTML.slice(0, 80),
    );
    expect(next, `${width}`).toBe('figure');
  }
});

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

test('the hero stage opens in the first phone viewport @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const top = await hero(page)
    .locator('[data-figure-stage]')
    .evaluate((stage) => stage.getBoundingClientRect().top);
  expect(top).toBeLessThan(844);
  // Kicker, H1, lede, calls to action, then the figure: the order the page is read and tabbed in.
  const order = await page.evaluate(() =>
    [
      '.home-hero__kicker',
      'h1',
      '.home-hero__lede',
      '.home-hero__actions',
      '[data-graphic="hero-globe"]',
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

  // From 1024 px to the split, the text is one row over the figure: the H1 left, the lede and
  // calls to action right. The calls to action and the stage top are both in the first view.
  for (const [width, height] of [
    [1024, 768],
    [1100, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const where = `${width}×${height}`;
    const title = (await page.locator('h1').boundingBox())!;
    const lede = (await page.locator('.home-hero__lede').boundingBox())!;
    const actions = (await page.locator('.home-hero__actions').boundingBox())!;
    const figure = (await hero(page).boundingBox())!;
    expect(title.x + title.width, where).toBeLessThanOrEqual(lede.x);
    expect(actions.y + actions.height, where).toBeLessThanOrEqual(height);
    expect(figure.y, where).toBeGreaterThanOrEqual(
      Math.max(title.y + title.height, actions.y + actions.height),
    );
    const top = await hero(page)
      .locator('[data-figure-stage]')
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(top, where).toBeLessThan(height);
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

test('at 320 px the layer segments stay inside their row @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  // At 320×640 the text fills the first view and the globe starts below it, so its entrance waits
  // to be scrolled to (the hero's calls to action come first, WCAG 2.4.3).
  await hero(page).locator('.hg-globe').scrollIntoViewIfNeeded();
  const figure = await liveHero(page);
  const group = figure.getByRole('group', { name: 'Layer' });
  const row = (await group.boundingBox())!;
  for (const button of await group.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    const name = await button.textContent();
    expect(box.x, `${name} left`).toBeGreaterThanOrEqual(row.x - 0.5);
    expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(
      row.x + row.width + 0.5,
    );
    const clipped = await button.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(clipped, `${name} label fits`).toBe(false);
  }
});

// Design review, round 2: where both fit (a 390 px phone) the two calls to action share one row of
// equal halves, so the globe gets the room; where they do not (320 px) they stack full width.
test('on a phone the hero’s calls to action are two equal buttons, side by side where they fit @mobile-chromium', async ({
  page,
}) => {
  for (const [width, sideBySide] of [
    [320, false],
    [390, true],
    [412, true],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const lede = (await page.locator('.home-hero__lede').boundingBox())!;
    const row = (await page.locator('.home-hero__actions').boundingBox())!;
    const [first, second] = await Promise.all(
      [0, 1].map(
        async (index) =>
          (await page
            .locator('.home-hero__actions .button-link')
            .nth(index)
            .boundingBox())!,
      ),
    );
    expect(Math.abs(first.width - second.width), `${width}`).toBeLessThan(1);
    expect(first.x, `${width}`).toBeCloseTo(lede.x, 0);
    if (sideBySide) {
      expect(second.y, `${width}`).toBeCloseTo(first.y, 0);
      expect(second.x + second.width, `${width}`).toBeCloseTo(
        row.x + row.width,
        0,
      );
    } else {
      expect(second.y, `${width}`).toBeGreaterThan(first.y + first.height - 1);
      expect(first.width, `${width}`).toBeCloseTo(row.width, 0);
    }
    // Labels never wrap inside a button.
    for (const box of [first, second])
      expect(box.height, `${width}`).toBeLessThan(70);
  }
});

// Design review, round 2: on a 390 × 844 phone only 40% of the disc showed in the first view, under
// text and stacked controls. The page is visual-first: at least 60% of it shows.
test('on a 390 × 844 phone most of the globe is in the first view @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const globe = (await hero(page).locator('.hg-globe').boundingBox())!;
  const shown = Math.min(844, globe.y + globe.height) - globe.y;
  expect(shown / globe.height).toBeGreaterThanOrEqual(0.6);
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
  // Nothing interactive prints: not the layer control (still on Evidence), not the focused
  // globe's reticle, not Reset view, not the readout.
  for (const control of [
    '.hg-layers',
    '.hg-reticle',
    '.hg-reset',
    '.hg-readout',
  ])
    await expect(figure.locator(control), control).toBeHidden();
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

// A tap on the globe answers where the eye already is (design review, round 1): the readout docks
// directly under the disc, above the three-row key, and the tapped key row is marked current.
test('on a phone the readout docks under the globe, above the key @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const figure = await liveHero(page);
  const globe = (await figure.locator('.hg-globe').boundingBox())!;
  const strip = (await figure.locator('.hg-readout').boundingBox())!;
  const key = (await figure.locator('.hg-step').first().boundingBox())!;
  expect(strip.y).toBeGreaterThanOrEqual(globe.y + globe.height - 0.5);
  expect(strip.y - (globe.y + globe.height)).toBeLessThan(24);
  expect(key.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);

  const third = figure.locator('.hg-step button').nth(2);
  await third.tap();
  await expect(readout(page)).toContainText('No estimate');
  await expect(third).toHaveAttribute('aria-current', 'true');
  await expect(figure.locator('.hg-step button[aria-current]')).toHaveCount(1);
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
