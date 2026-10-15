/**
 * Home's hero film and Atlas preview, in the browser (site redesign spec §4.1, §9.1; round 2
 * rulings R2-1, R2-2, R2-12, R2-14; round 2 spec §11.2; #454). Owned by the hero and toy-globe task
 * (round 2 plan T1); split verbatim out of marketing-home.spec.ts (plan T0 step 3). Rotation timing
 * runs on Playwright's fake clock, never on wall-clock sleeps.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

declare global {
  interface Window {
    __lcp?: { element: string; time: number }[];
  }
}

/* ------------------------------------------------------------------ the hero film */

const film = (page: Page) => page.locator('[data-hero-media]');
const filmVideo = (page: Page) => page.locator('.hero-media__video');
const filmToggle = (page: Page) => page.locator('[data-video-toggle]');

/** The film once its first frame is up. */
async function playingFilm(page: Page): Promise<Locator> {
  const root = film(page);
  await expect(root).toHaveAttribute('data-video', 'playing', {
    timeout: 15_000,
  });
  await expect(root).toHaveAttribute('data-video-frame', '');
  return root;
}

const videoPaused = (page: Page) =>
  filmVideo(page).evaluate((video: HTMLVideoElement) => video.paused);

test('the film’s poster is the LCP, and the film loads only after the load event', async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() => {
    const entries: { element: string; time: number }[] = [];
    window.__lcp = entries;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        element: Element | null;
      })[])
        entries.push({
          element: entry.element?.className ?? '',
          time: entry.startTime,
        });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  // A 1440 px desktop at 1x takes the 1080p film; the phone profile (412 px at 2.625x) the 720p.
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  // The film streams as it plays, so its resource timing entry lands only when the whole minute has
  // arrived. Its requests (often several ranges of one file) are read as they start instead.
  const filmRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/hero/')) filmRequests.push(request);
  });
  await page.goto('/');
  await playingFilm(page);
  const timing = await page.evaluate(() => {
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    return {
      load: performance.timeOrigin + navigation.loadEventEnd,
      lcp: window.__lcp ?? [],
    };
  });
  expect(filmRequests.length).toBeGreaterThan(0);
  // The poster paints first and stays the largest paint: the film is the same size, so its first
  // frame never becomes a new candidate.
  expect(timing.lcp.at(-1)?.element).toBe('hero-media__poster');
  // One rendition, AV1 first: 720p on the phone profile, 1080p on the desktop one.
  expect([
    ...new Set(filmRequests.map((request) => request.url().split('/').pop())),
  ]).toEqual([isMobile ? 'hero-720.av1.mp4' : 'hero-1080.av1.mp4']);
  for (const request of filmRequests) {
    expect(request.resourceType()).toBe('media');
    // The browser's own start time for the request (epoch ms), known once its response has begun.
    await request.response();
    expect(request.timing().startTime).toBeGreaterThanOrEqual(timing.load);
  }
  // The poster's own attributes.
  const poster = page.locator('.hero-media__poster');
  await expect(poster).toHaveAttribute('fetchpriority', 'high');
  await expect(poster).toHaveAttribute('loading', 'eager');
  await expect(poster).toHaveAttribute('width', '2560');
  await expect(poster).toHaveAttribute('height', '1440');
  expect(
    await poster.evaluate((image: HTMLImageElement) =>
      image.currentSrc.replace(/^.*\./, ''),
    ),
  ).toBe('avif');
});

test('the film fades in over the poster, and its control pauses and plays it', async ({
  page,
}) => {
  await page.goto('/');
  const root = await playingFilm(page);
  await expect(filmVideo(page)).toHaveCSS('opacity', '1');
  await expect(page.locator('.hero-media__poster')).toBeVisible();
  // Decorative: the film is out of the accessibility tree; its control is a plain button.
  await expect(
    page.locator('.hero-media__backdrop[aria-hidden="true"] video'),
  ).toHaveCount(1);
  const toggle = filmToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAccessibleName('Pause the background video');
  await expect(toggle).toHaveText('Pause');
  const box = (await toggle.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);

  await toggle.click();
  await expect(root).toHaveAttribute('data-video', 'paused');
  expect(await videoPaused(page)).toBe(true);
  await expect(toggle).toHaveAccessibleName('Play the background video');
  await expect(toggle).toHaveText('Play');
  // The paused frame stays up; it does not drop back to the poster.
  await expect(filmVideo(page)).toHaveCSS('opacity', '1');

  await toggle.press('Enter');
  await expect(root).toHaveAttribute('data-video', 'playing');
  await expect.poll(() => videoPaused(page)).toBe(false);
  await expect(toggle).toHaveText('Pause');
});

test('the film pauses off screen and in a hidden tab, and resumes only if the visitor has not paused it', async ({
  page,
}) => {
  await page.goto('/');
  await playingFilm(page);
  const scrollTo = (top: number) =>
    page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);

  await scrollTo(99_999);
  await expect.poll(() => videoPaused(page)).toBe(true);
  await scrollTo(0);
  await expect.poll(() => videoPaused(page)).toBe(false);

  // A hidden tab.
  const visibility = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await visibility(true);
  await expect.poll(() => videoPaused(page)).toBe(true);
  await visibility(false);
  await expect.poll(() => videoPaused(page)).toBe(false);

  // Paused by the visitor, it stays paused across both.
  await filmToggle(page).click();
  await scrollTo(99_999);
  await scrollTo(0);
  await visibility(true);
  await visibility(false);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(await videoPaused(page)).toBe(true);
  await expect(film(page)).toHaveAttribute('data-video', 'paused');
});

const POSTER_CASES = [
  { reason: 'reduced-motion', reduce: true, script: '' },
  {
    reason: 'save-data',
    reduce: false,
    script:
      "Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g', addEventListener() {} } });",
  },
  {
    reason: 'slow-connection',
    reduce: false,
    script:
      "Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: false, effectiveType: '3g', addEventListener() {} } });",
  },
  {
    reason: 'unsupported',
    reduce: false,
    script: "HTMLMediaElement.prototype.canPlayType = () => '';",
  },
] as const;

for (const { reason, reduce, script } of POSTER_CASES)
  test(`the poster stays, with no film and no control: ${reason}`, async ({
    page,
  }) => {
    if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
    if (script) await page.addInitScript(script);
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto('/');
    const root = film(page);
    await expect(root).toHaveAttribute('data-video-reason', reason);
    await expect(root).toHaveAttribute('data-video', 'poster');
    await expect(filmVideo(page).locator('source')).toHaveCount(0);
    await expect(filmToggle(page)).toBeHidden();
    await expect(page.locator('.hero-media__poster')).toBeVisible();
    await expect(filmVideo(page)).toHaveCSS('opacity', '0');
    expect(requested.filter((url) => url.includes('/media/hero/'))).toEqual([]);
  });

/** The film's opacity, scrolled `share` of the way from the hero's top to its bottom. */
async function recededAt(page: Page, share: number): Promise<number> {
  return page.evaluate(async (fraction) => {
    const hero = document.querySelector<HTMLElement>('.home-hero')!;
    const top = hero.getBoundingClientRect().top + scrollY;
    window.scrollTo({
      top: top + hero.offsetHeight * fraction,
      behavior: 'instant',
    });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return Number(
      getComputedStyle(document.querySelector('[data-hero-backdrop]')!).opacity,
    );
  }, share);
}

test('the film recedes as the page scrolls into the content', async ({
  page,
}) => {
  await page.goto('/');
  expect(await recededAt(page, 0)).toBeCloseTo(1, 2);
  // From the hero's top reaching the top of the screen to three quarters of it gone.
  const middle = await recededAt(page, 0.375);
  expect(middle).toBeGreaterThan(0.35);
  expect(middle).toBeLessThan(0.65);
  expect(await recededAt(page, 0.75)).toBeLessThan(0.02);
  // Linked to the scroll only: back at the top it is whole again.
  expect(await recededAt(page, 0)).toBeCloseTo(1, 2);
});

test('the film’s Pause control fades with the film, and no hairline marks the film’s end', async ({
  page,
}) => {
  await page.goto('/');
  await playingFilm(page);
  const toggle = filmToggle(page);
  const opacity = () =>
    toggle.evaluate((element) => Number(getComputedStyle(element).opacity));
  expect(await recededAt(page, 0)).toBeCloseTo(1, 2);
  expect(await opacity()).toBeCloseTo(1, 2);
  const middle = await recededAt(page, 0.375);
  expect(Math.abs((await opacity()) - middle)).toBeLessThan(0.05);
  await recededAt(page, 0.8);
  expect(await opacity()).toBeLessThan(0.02);
  await expect(toggle).toBeHidden();
  // Back at the top it is whole again, and still works.
  await recededAt(page, 0);
  await expect(toggle).toBeVisible();
  expect(await opacity()).toBeCloseTo(1, 2);
  // The film's foot melts into the page: the Atlas section below draws no top rule.
  await expect(page.locator('#atlas')).toHaveCSS('border-top-width', '0px');
});

test('reduced motion: the film never recedes with the scroll, and nothing runs', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const share of [0, 0.375, 0.75])
    expect(await recededAt(page, share)).toBe(1);
  const animations = await page
    .locator('[data-hero-backdrop]')
    .evaluate((element) => element.getAnimations().length);
  expect(animations).toBe(0);

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

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Issue #419 (ruling R2-12): on a phone the old hero's floating labels covered its calls to action.
 * Nothing laid over the hero (its film's control, the fixed header, the cookie control, any
 * absolutely or fixed positioned element) may overlap the headline, the lede or a call to action.
 */
test('on a phone nothing over the hero overlaps its headline or calls to action (#419) @mobile-chromium', async ({
  page,
}) => {
  for (const [width, height] of [
    [320, 640],
    [360, 740],
    [390, 844],
    [430, 932],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await playingFilm(page);
    await expect(filmToggle(page)).toBeVisible();
    const { text, overlays } = await page.evaluate(() => {
      const box = (element: Element) => {
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      const shown = (element: Element) =>
        element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }) && element.getBoundingClientRect().width > 0;
      const hero = document.querySelector('.home-hero')!;
      const own = document.querySelector('.home-hero__text')!;
      const backdrop = document.querySelector('[data-hero-backdrop]')!;
      const text = [
        ['headline', document.querySelector('.home-hero h1')!],
        ['lede', document.querySelector('.home-hero__lede')!],
        ...[...document.querySelectorAll('.home-hero__actions a')].map(
          (link) => [`“${link.textContent?.trim()}”`, link] as const,
        ),
      ].map(([name, element]) => ({ name, ...box(element as Element) }));
      const heroBox = hero.getBoundingClientRect();
      const overlays = [...document.querySelectorAll('body *')]
        .filter((element) => {
          const position = getComputedStyle(element).position;
          return position === 'fixed' || position === 'absolute';
        })
        .filter(
          (element) =>
            !own.contains(element) &&
            !backdrop.contains(element) &&
            !element.contains(hero) &&
            shown(element),
        )
        .map((element) => ({
          name:
            (element.getAttribute('class') ?? element.localName).split(
              ' ',
            )[0] || element.localName,
          ...box(element),
        }))
        .filter(
          (entry) =>
            entry.right > heroBox.left &&
            entry.left < heroBox.right &&
            entry.bottom > heroBox.top &&
            entry.top < heroBox.bottom,
        );
      return { text, overlays };
    });
    expect(text.length, `${width}`).toBeGreaterThanOrEqual(4);
    // The film's control is among the overlays checked.
    expect(
      overlays.some((overlay) => overlay.name === 'hero-media__toggle'),
      `${width}`,
    ).toBe(true);
    for (const target of text)
      for (const overlay of overlays)
        expect(
          overlaps(target, overlay),
          `${overlay.name} over the ${target.name} at ${width} px`,
        ).toBe(false);
    // And everything is on the first screen, clear of the cookie control's corner (spec §2.4).
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    for (const target of text) {
      expect(target.bottom, `${target.name} at ${width}`).toBeLessThanOrEqual(
        height - 4.5 * rem + 0.5,
      );
      expect(target.top, `${target.name} at ${width}`).toBeGreaterThanOrEqual(
        0,
      );
    }
  }
});

// WCAG 2.4.3: the calls to action are read and reached before any other control: the film's
// Pause, then the Atlas preview's.
test('the hero’s calls to action come right after its heading in the focus order', async ({
  page,
}) => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await playingFilm(page);
    await page.locator('h1').evaluate((title: HTMLElement) => {
      title.tabIndex = -1;
      title.focus();
    });
    for (const index of [0, 1]) {
      await page.keyboard.press('Tab');
      await expect(
        page.locator('.home-hero__actions .button-link').nth(index),
        `${width}`,
      ).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(filmToggle(page), `${width}`).toBeFocused();
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() =>
      document.activeElement?.closest('#atlas')
        ? 'atlas'
        : document.activeElement?.outerHTML.slice(0, 80),
    );
    expect(next, `${width}`).toBe('atlas');
  }
});

// Design review, round 2: where both fit the two calls to action share one row of equal halves;
// where they do not they stack full width.
test('on a phone the hero’s calls to action are two equal buttons, side by side where they fit @mobile-chromium', async ({
  page,
}) => {
  for (const [width, sideBySide] of [
    [320, false],
    [360, false],
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

// The film fills the first view on laptops and desktops, its text on the left beside the globe the
// clip keeps on the right, and the calls to action are on screen.
test('the hero fills the first view, its text on the left and its calls to action on screen @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  for (const [width, height] of [
    [1024, 768],
    [1152, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    const where = `${width}×${height}`;
    const hero = (await page.locator('.home-hero').boundingBox())!;
    const actions = (await page.locator('.home-hero__actions').boundingBox())!;
    // The text's right edge: its widest line, not its box.
    const right = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll('.home-hero__text > *')].flatMap(
          (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()].map((rect) => rect.right);
          },
        ),
      ),
    );
    expect(hero.y + hero.height, where).toBeGreaterThanOrEqual(height - 1);
    expect(hero.width, where).toBe(width);
    expect(right, where).toBeLessThanOrEqual(width * 0.6);
    expect(actions.y + actions.height, where).toBeLessThanOrEqual(height);
  }
});

// The bottom-right 4.5rem belongs to the cookie control (spec §2.4): on a tablet in portrait the
// hero's text, its calls to action and the film's control stay out of it.
test('on a tablet no part of the hero reaches the cookie control’s corner @desktop-chromium', async ({
  page,
}) => {
  for (const [width, height] of [
    [768, 1024],
    [820, 1180],
    [834, 1194],
    [1024, 1366],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await playingFilm(page);
    const inCorner = await page.evaluate(() => {
      const zone =
        parseFloat(getComputedStyle(document.documentElement).fontSize) * 4.5;
      const left = innerWidth - zone;
      const top = innerHeight - zone;
      return [
        ...document.querySelectorAll('.home-hero__text *, .hero-media__toggle'),
      ]
        .filter((element) => element.checkVisibility())
        .filter((element) =>
          [...element.getClientRects()].some(
            (rect) =>
              rect.width > 0 &&
              rect.right > left &&
              rect.bottom > top &&
              rect.top < innerHeight,
          ),
        )
        .map((element) => element.getAttribute('class'));
    });
    expect(inCorner, `${width}×${height}`).toEqual([]);
  }
});

/* ------------------------------------------------------------------ the Atlas preview */

const preview = (page: Page) =>
  page.locator('figure[data-graphic="atlas-preview"]');

/** The preview once its data is decoded, its canvas is up and its entrance has rested. */
async function livePreview(page: Page): Promise<Locator> {
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-live', '', { timeout: 8_000 });
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 8_000,
  });
  return figure;
}

/** A hash of the canvas's pixels: it changes when the globe turns. */
const canvasPixels = (page: Page) =>
  page.locator('#atlas-preview .hg-canvas').evaluate((canvas) => {
    const data = (canvas as HTMLCanvasElement).toDataURL();
    let hash = 0;
    for (let index = 0; index < data.length; index += 1)
      hash = (hash * 31 + data.charCodeAt(index)) | 0;
    return hash;
  });

/**
 * On Playwright's fake clock, paused: open Home, bring the preview into view and let its data load
 * and its entrance play, so it rests at its starting view (the rotation's hold begins there). Time
 * then moves only with `page.clock.runFor`.
 */
async function previewOnClock(page: Page): Promise<Locator> {
  const start = new Date('2026-10-14T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto('/');
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  // fastForward fires one frame per step, where runFor would draw every frame of the entrance:
  // the rest state is what these tests need, and software WebGL on CI draws a phone-sized globe
  // too slowly for ~180 frames to fit the wait.
  await expect(async () => {
    await page.clock.fastForward(250);
    await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 100,
    });
  }).toPass({ timeout: 15_000 });
  await expect(figure).toHaveAttribute('data-live', '');
  return figure;
}

test('the preview turns slowly by itself after a hold on its starting view, and stops off screen', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  // The leaders join the callouts to their pins while it holds (the wide form draws them).
  await expect(figure.locator('.hg-leader').first()).toHaveCSS('opacity', '1');
  const still = await canvasPixels(page);
  await page.clock.runFor(4500);
  expect(await canvasPixels(page)).toBe(still);

  await page.clock.runFor(1000);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  await page.clock.runFor(2000);
  expect(await canvasPixels(page)).not.toBe(still);
  // Turning: the leaders fade; the pins ride on and the callouts stay as the key.
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await expect(figure.locator('.hg-leader').first()).toHaveCSS('opacity', '0');
  await expect(figure.locator('.hg-callout')).toHaveCount(3);
  for (const callout of await figure.locator('.hg-callout').all())
    await expect(callout).toBeVisible();
  await expect(
    figure.getByRole('button', { name: 'Pause the rotation' }),
  ).toBeVisible();

  // Off screen it stops, and draws nothing more.
  await page.evaluate(() =>
    window.scrollTo({ top: 99_999, behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-spin', 'stopped');
  const away = await canvasPixels(page);
  await page.clock.runFor(5000);
  expect(await canvasPixels(page)).toBe(away);
  // Back on screen it turns again.
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-spin', 'running');
});

test('pointing at or focusing the globe holds it; it turns again 4 s after @desktop-chromium', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await page.clock.runFor(5500);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  const globe = figure.locator('.hg-globe');
  await globe.hover();
  await expect(figure).toHaveAttribute('data-spin', 'held');
  const held = await canvasPixels(page);
  await page.clock.runFor(10_000);
  expect(await canvasPixels(page)).toBe(held);
  // The pointer leaves: about 4 s of quiet, then it turns.
  await page.mouse.move(5, 5);
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  await page.clock.runFor(3800);
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  await page.clock.runFor(400);
  await expect(figure).toHaveAttribute('data-spin', 'running');

  // Keyboard focus holds it the same way.
  await globe.focus();
  await expect(figure).toHaveAttribute('data-spin', 'held');
  await globe.blur();
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  await page.clock.runFor(4200);
  await expect(figure).toHaveAttribute('data-spin', 'running');
});

test('a drag holds the rotation too, and the globe turns under it again 4 s later', async ({
  page,
  isMobile,
}) => {
  const figure = await previewOnClock(page);
  await page.clock.runFor(5500);
  const globe = figure.locator('.hg-globe');
  const box = (await globe.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width * 0.3;
  if (isMobile) {
    // A real touch drag, sideways (vertical drags scroll the page: pan-y).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    await expect(figure).toHaveAttribute('data-spin', 'held');
    for (let step = 1; step <= 8; step += 1)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + step * 16, y }],
      });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(figure).toHaveAttribute('data-spin', 'held');
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.move(x + 140, y, { steps: 4 });
    await page.mouse.up();
    await page.mouse.move(2, 2);
  }
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  await page.clock.runFor(4200);
  await expect(figure).toHaveAttribute('data-spin', 'running');
});

test('Pause stops the rotation until Play, whatever the visitor does', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await page.clock.runFor(5500);
  const pause = figure.getByRole('button', { name: 'Pause the rotation' });
  await pause.click();
  await expect(figure).toHaveAttribute('data-spin', 'paused');
  const play = figure.getByRole('button', { name: 'Play the rotation' });
  await expect(play).toHaveText('Play');
  const paused = await canvasPixels(page);
  await figure.locator('.hg-globe').focus();
  await figure.locator('.hg-globe').blur();
  await page.clock.runFor(15_000);
  await expect(figure).toHaveAttribute('data-spin', 'paused');
  expect(await canvasPixels(page)).toBe(paused);
  await play.click();
  await expect(figure).toHaveAttribute('data-spin', 'running');
  await page.clock.runFor(1500);
  expect(await canvasPixels(page)).not.toBe(paused);
});

test('reduced motion: the preview rests at once, never turns, and offers no Pause', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const figure = await previewOnClock(page);
  await expect(figure.locator('.hg-callout.is-off')).toHaveCount(0);
  const still = await canvasPixels(page);
  await page.clock.runFor(30_000);
  await expect(figure).toHaveAttribute('data-spin', 'off');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  expect(await canvasPixels(page)).toBe(still);
  await expect(figure.locator('[data-spin-toggle]')).toBeHidden();
  // The globe still turns when asked, at once.
  await figure.locator('.hg-globe').focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');
});

test('the preview says what it is, and its button opens the genomeOS Atlas', async ({
  page,
}) => {
  await page.goto('/');
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  // Ruling R2-14: a plain note, never a status tag.
  await expect(figure.locator('.kit-status-tag')).toHaveCount(0);
  await expect(figure).not.toContainText('Not yet validated');
  await expect(figure.locator('.hg-note__text')).toHaveText(
    'A simplified preview with sample data.',
  );
  const open = figure.getByRole('link', { name: 'Open the genomeOS Atlas' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', '/app/');
  const box = (await open.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // The wordmark type, as every visible genomeOS.
  await expect(open.locator('.brand-name')).toHaveText('genomeOS');
  // One control besides it: the Measured · Modeled toggle (and the rotation's Pause).
  const layers = figure.getByRole('group', { name: 'Layer' });
  await expect(layers.getByRole('button')).toHaveText(['Measured', 'Modeled']);
  await expect(
    figure.locator('.hg-step, [data-readout], .hg-reset'),
  ).toHaveCount(0);
});

test('the layer control has one pressed layer and swaps the legend', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  const layers = figure.getByRole('group', { name: 'Layer' });
  const pressed = layers.locator('[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveText('Modeled');
  await expect(figure.locator('figcaption')).toContainText(
    'Fades away from surveys',
  );
  await layers.getByRole('button', { name: 'Measured' }).click();
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveText('Measured');
  await expect(figure.locator('[data-legend="measured"]')).toBeVisible();
  await expect(figure.locator('[data-legend="measured"]')).toContainText(
    'Model grid, no values drawn',
  );
  await expect(figure.locator('[data-legend="modeled"]')).toBeHidden();
});

/** The preview at rest: its disc (the globe box), stage and visible callout boxes. */
function previewGeometry(page: Page) {
  return page.evaluate(() => {
    const figure = document.querySelector('[data-graphic="atlas-preview"]')!;
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
      callouts: [...figure.querySelectorAll<HTMLElement>('.hg-callout')].map(
        (element) => ({ kind: element.dataset.callout!, ...box(element) }),
      ),
    };
  });
}

test('the callouts sit in the stage margins, clear of the disc and its studs @desktop-chromium', async ({
  page,
}) => {
  await page.goto('/');
  // From the narrowest wide form (one column, the figure just over 36rem) through the split.
  for (const [width, height] of [
    [720, 900],
    [768, 1024],
    [1100, 900],
    [1152, 768],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    const { disc, stage, callouts } = await previewGeometry(page);
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
      for (const other of callouts.filter((entry) => entry !== callout))
        expect(overlaps(callout, other), where).toBe(false);
    }
  }
});

// The Modeled pin marks modeling (owner review, round 2): on screen, no stud is near it.
test('the Modeled pin stands clear of every measured stud @desktop-chromium', async ({
  page,
}) => {
  // At rest, so the pin stays where the build placed it.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await livePreview(page);
  const ring = page.locator(
    '#atlas-preview .hg-marker[data-callout="modeled"] .hg-marker__ring',
  );
  const box = (await ring.boundingBox())!;
  // The studs are white: twice the ring's width around it holds none of their pixels once the
  // pin itself is hidden.
  const clip = {
    x: box.x - box.width / 2,
    y: box.y - box.height / 2,
    width: box.width * 2,
    height: box.height * 2,
  };
  const crop = await page.screenshot({ clip });
  await ring.evaluate((element) => {
    (element.parentElement as HTMLElement).style.visibility = 'hidden';
  });
  const without = await page.screenshot({ clip });
  expect(crop.equals(without)).toBe(false);
  const white = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (
        pixels[index] > 225 &&
        pixels[index + 1] > 225 &&
        pixels[index + 2] > 225
      )
        count += 1;
    return count;
  }, without.toString('base64'));
  expect(white).toBe(0);
});

test('dragging turns the globe: the leaders step aside until Home brings it back @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const figure = await livePreview(page);
  const globe = figure.locator('.hg-globe');
  const box = (await globe.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 4 });
  await page.mouse.move(centre.x + 140, centre.y, { steps: 4 });
  await page.mouse.up();
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await expect(figure.locator('.hg-leader').first()).toHaveCSS('opacity', '0');
  // The pins ride on with the globe; the callouts stay.
  await expect(figure.locator('.hg-callout').first()).toHaveCSS('opacity', '1');
  await globe.focus();
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(figure.locator('.hg-leader').first()).toHaveCSS('opacity', '1');
});

test('arrow keys turn the focused globe, and Home returns it to its starting view', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-view', 'rest');
});

test('at 320 px the layer segments and the Pause control stay inside their row @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  const figure = await livePreview(page);
  const toolbar = (await figure.locator('.kit-figure__toolbar').boundingBox())!;
  const group = figure.getByRole('group', { name: 'Layer' });
  for (const button of [
    ...(await group.getByRole('button').all()),
    figure.locator('[data-spin-toggle]'),
  ]) {
    const box = (await button.boundingBox())!;
    const name = await button.textContent();
    expect(box.x, `${name} left`).toBeGreaterThanOrEqual(toolbar.x - 0.5);
    expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(
      toolbar.x + toolbar.width + 0.5,
    );
    const clipped = await button.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(clipped, `${name} label fits`).toBe(false);
  }
});

// Forced colours hide the canvas and show the poster, the Modeled starting view (spec §2.2), so
// the figure is its poster: nothing turns or switches a hidden canvas. The film's frame is
// decorative, so the hero's text sits on the system's own background.
test('in forced colours the preview is its poster and the hero drops its film', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  await expect(page.locator('[data-hero-backdrop]')).toHaveCSS(
    'visibility',
    'hidden',
  );
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-mode', 'poster');
  await expect(figure.locator('.hg-poster')).toBeVisible();
  await expect(figure.locator('.hg-layers')).toBeHidden();
  await expect(figure.locator('[data-spin-toggle]')).toBeHidden();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(figure.locator('[data-legend="measured"]')).toBeHidden();
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  for (let press = 0; press < 3; press += 1)
    await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  for (const callout of await figure.locator('.hg-callout').all())
    await expect(callout).toBeVisible();
  for (const pin of await figure.locator('.hg-marker__badge').all())
    await expect(pin).toBeVisible();
});

test('turning forced colours on mid-visit returns the preview to its poster, and off to the live globe', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  const layers = figure.locator('.hg-layers');
  await layers.getByRole('button', { name: 'Measured' }).click();
  await figure.locator('.hg-globe').focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');

  await page.emulateMedia({ forcedColors: 'active' });
  await expect(figure).toHaveAttribute('data-mode', 'poster');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(layers).toBeHidden();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(layers.locator('[aria-pressed="true"]')).toHaveText('Modeled');

  await page.emulateMedia({ forcedColors: 'none' });
  await expect(figure).not.toHaveAttribute('data-mode', 'poster');
  await expect(figure).toHaveAttribute('data-live', '');
  await expect(layers).toBeVisible();
});

// The canvas never prints; the poster (Modeled, at the starting view) does, so the print carries
// its legend, pins, leaders and callouts, never a turned view or a control.
test('printing after a layer switch and a turn shows the poster’s own legend and callouts', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  await figure
    .getByRole('group', { name: 'Layer' })
    .getByRole('button', { name: 'Measured' })
    .click();
  await figure.locator('.hg-globe').focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  await expect(figure.locator('.hg-poster')).toBeVisible();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(figure.locator('[data-legend="measured"]')).toBeHidden();
  for (const control of ['.hg-layers', '[data-spin-toggle]'])
    await expect(figure.locator(control), control).toBeHidden();
  // The pins back at the starting view, with their callouts and (wide form) leaders.
  for (const mark of await figure
    .locator('.hg-callout, .hg-marker__ring')
    .all())
    await expect(mark).toBeVisible();
  for (const leader of await figure.locator('.hg-leader').all())
    await expect(leader).toHaveCSS('opacity', '1');
  await expect(figure.locator('.hg-marker').first()).not.toHaveAttribute(
    'style',
    /left/,
  );
  await expect(page.locator('.hero-media__video')).toBeHidden();
  await expect(page.locator('[data-video-toggle]')).toBeHidden();
});

test('Home loads its own figure data and no decorative raster but the film’s poster', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto('/');
  await livePreview(page);
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
    if (/\.(avif|webp|png|jpe?g)(\?|$)/.test(url))
      expect(url).toMatch(/\/_astro\/hero-poster\.|\/brand\/|favicon/);
  }
});
