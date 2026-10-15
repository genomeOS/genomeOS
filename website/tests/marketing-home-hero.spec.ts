/**
 * Home's hero film and Atlas preview, in the browser (site redesign spec §4.1, §9.1; round 2 spec
 * §4.1.1, §4.1.5, §11.2 H-1…H-10 and G-1…G-6; rulings R2-1, R2-2, R2-12, R2-14, R2-16 and 21–26 of
 * the round-2 build; #454). Owned by the hero and toy-globe task (round 2 plan T1). Rotation timing
 * runs on Playwright's fake clock or the motion hooks' seek (the e2e build), never on wall-clock
 * sleeps.
 */
import AxeBuilder from '@axe-core/playwright';
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
    __frames?: { requested: number; pending: Set<number> };
  }
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Two frames, so a seek or a style change has painted. */
const twoFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

/** Count requestAnimationFrame calls and the frames still pending (as motion.spec does). */
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

const frameCount = (page: Page) =>
  page.evaluate(() => ({
    requested: window.__frames?.requested ?? 0,
    pending: window.__frames?.pending.size ?? 0,
  }));

/** A hidden (or shown) tab, as the page sees it. */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

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

test('the film’s poster is the LCP, and the film loads only after the load event (H-6, H-10)', async ({
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

test('the film fades in over the poster; its control is a white glyph that pauses and plays it', async ({
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
  await expect(toggle).toHaveAttribute('data-state', 'playing');
  // Ruling 22: a white glyph, no background, no border, no visible words; a 44 px target round an
  // 18–20 px glyph.
  const look = await toggle.evaluate((button) => {
    const style = getComputedStyle(button);
    const glyph = button.querySelector('svg')!.getBoundingClientRect();
    const shown = [...button.querySelectorAll('path')]
      .filter((path) => getComputedStyle(path).display !== 'none')
      .map((path) => path.getAttribute('class'));
    const words = [...button.childNodes]
      .filter(
        (node) =>
          !(node instanceof Element && node.matches('svg, .visually-hidden')),
      )
      .map((node) => node.textContent?.trim())
      .join('');
    return {
      background: style.backgroundColor,
      border: style.borderTopWidth,
      color: style.color,
      filter: style.filter,
      glyph: [glyph.width, glyph.height],
      shown,
      words,
    };
  });
  expect(look.background).toBe('rgba(0, 0, 0, 0)');
  expect(look.border).toBe('0px');
  expect(look.color).toBe('rgb(242, 248, 255)');
  expect(look.filter).toContain('drop-shadow');
  expect(look.glyph[0]).toBeGreaterThanOrEqual(18);
  expect(look.glyph[0]).toBeLessThanOrEqual(20);
  expect(look.shown).toEqual(['kit-scene-control__pause']);
  expect(look.words).toBe('');
  const box = (await toggle.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);

  await toggle.click();
  await expect(root).toHaveAttribute('data-video', 'paused');
  expect(await videoPaused(page)).toBe(true);
  await expect(toggle).toHaveAccessibleName('Play the background video');
  await expect(toggle).toHaveAttribute('data-state', 'paused');
  await expect(toggle.locator('.kit-scene-control__play')).toBeVisible();
  await expect(toggle.locator('.kit-scene-control__pause')).toBeHidden();
  // The paused frame stays up; it does not drop back to the poster.
  await expect(filmVideo(page)).toHaveCSS('opacity', '1');

  await toggle.press('Enter');
  await expect(root).toHaveAttribute('data-video', 'playing');
  await expect.poll(() => videoPaused(page)).toBe(false);
  await expect(toggle).toHaveAccessibleName('Pause the background video');
});

test('the film pauses off screen and in a hidden tab, and stays paused after the visitor’s Pause (H-8)', async ({
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

  await setHidden(page, true);
  await expect.poll(() => videoPaused(page)).toBe(true);
  await setHidden(page, false);
  await expect.poll(() => videoPaused(page)).toBe(false);

  // Paused by the visitor, it stays paused across both.
  await filmToggle(page).click();
  await scrollTo(99_999);
  await scrollTo(0);
  await setHidden(page, true);
  await setHidden(page, false);
  await twoFrames(page);
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
  test(`the poster stays, with no film and no control: ${reason} (H-6)`, async ({
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

// Spec §8.9 (review of T1): forced colours hide the film's backdrop, so the film is never fetched
// and no Pause shows for a film nobody could see.
test('in forced colours the film never loads and its control never shows (H-6)', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto('/');
  const root = film(page);
  await expect(root).toHaveAttribute('data-video-reason', 'forced-colors');
  await expect(root).toHaveAttribute('data-video', 'poster');
  await expect(filmVideo(page).locator('source')).toHaveCount(0);
  await expect(filmToggle(page)).toBeHidden();
  await page.waitForTimeout(1000);
  expect(requested.filter((url) => url.includes('/media/hero/'))).toEqual([]);
});

// Round 2 spec §0.3 #19: where NetworkInformation is missing (Safari, Firefox), a poster that
// arrives below 1.5 Mbit/s keeps the film off. Here the connection is throttled for real.
test('without NetworkInformation, a slowly arriving poster keeps the film off (H-6)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: undefined,
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // About 0.8 Mbit/s down, no added latency.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: 100_000,
    uploadThroughput: 100_000,
  });
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto('/', { timeout: 45_000 });
  const root = film(page);
  await expect(root).toHaveAttribute('data-video-reason', 'slow-connection', {
    timeout: 20_000,
  });
  await expect(filmToggle(page)).toBeHidden();
  expect(requested.filter((url) => url.includes('/media/hero/'))).toEqual([]);
});

// Round 2 spec §0.3 #17: a visitor's Pause is remembered, and a remembered Pause fetches nothing
// until they press Play.
test('a remembered Pause keeps the poster with Play over it, and Play brings the film (H-6)', async ({
  page,
}) => {
  await page.goto('/');
  await playingFilm(page);
  await filmToggle(page).click();
  expect(
    await page.evaluate(() => localStorage.getItem('genomeos:hero-motion')),
  ).toBe('paused');

  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.reload();
  const root = film(page);
  await expect(root).toHaveAttribute('data-video-reason', 'remembered-pause');
  await expect(root).toHaveAttribute('data-video', 'poster');
  const toggle = filmToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAccessibleName('Play the background video');
  await expect(toggle).toHaveAttribute('data-state', 'paused');
  await expect(filmVideo(page).locator('source')).toHaveCount(0);
  expect(requested.filter((url) => url.includes('/media/hero/'))).toEqual([]);

  await toggle.click();
  await playingFilm(page);
  expect(requested.some((url) => url.includes('/media/hero/'))).toBe(true);
  await expect(toggle).toHaveAccessibleName('Pause the background video');
  expect(
    await page.evaluate(() => localStorage.getItem('genomeos:hero-motion')),
  ).toBeNull();
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
  const whole = await opacity();
  expect(whole).toBeGreaterThan(0.9);
  const middle = await recededAt(page, 0.375);
  expect(Math.abs((await opacity()) / whole - middle)).toBeLessThan(0.06);
  await recededAt(page, 0.8);
  expect(await opacity()).toBeLessThan(0.02);
  await expect(toggle).toBeHidden();
  // Back at the top it is whole again, and still works.
  await recededAt(page, 0);
  await expect(toggle).toBeVisible();
  expect(await opacity()).toBeCloseTo(whole, 2);
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

/**
 * Issue #419 (ruling R2-12; H-1): on a phone the old hero's floating labels covered its calls to
 * action. Nothing laid over the hero (its film's control, the fixed header, the cookie control, any
 * absolutely or fixed positioned element) may overlap the headline, the lede or a call to action.
 */
test('on a phone nothing over the hero overlaps its headline or calls to action (#419, H-1) @mobile-chromium', async ({
  page,
}) => {
  for (const [width, height] of [
    [320, 568],
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
            !element.closest('.visually-hidden') &&
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

test('on a phone Home never scrolls sideways (H-2) @mobile-chromium', async ({
  page,
}) => {
  for (const width of [320, 360, 375, 390, 400, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await twoFrames(page);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, `${width} px`).toBe(client);
  }
});

test('on a short phone screen the calls to action are on the first screen (H-3) @mobile-chromium', async ({
  page,
}) => {
  for (const [width, height] of [
    [390, 664],
    [360, 640],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    for (const link of await page.locator('.home-hero__actions a').all()) {
      const box = (await link.boundingBox())!;
      expect(box.y + box.height, `${width}×${height}`).toBeLessThanOrEqual(
        height,
      );
    }
  }
});

test('on a desktop the film’s Pause keeps 1.5rem from the calls to action (H-4) @desktop-chromium', async ({
  page,
}) => {
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await playingFilm(page);
    const actions = (await page.locator('.home-hero__actions').boundingBox())!;
    const toggle = (await filmToggle(page).boundingBox())!;
    const dx = Math.max(
      0,
      toggle.x - (actions.x + actions.width),
      actions.x - (toggle.x + toggle.width),
    );
    const dy = Math.max(
      0,
      toggle.y - (actions.y + actions.height),
      actions.y - (toggle.y + toggle.height),
    );
    expect(Math.hypot(dx, dy), `${width}×${height}`).toBeGreaterThanOrEqual(24);
  }
});

test('the hero holds one heading, one lede, one of each call to action, then the film’s control (H-5)', async ({
  page,
}) => {
  await page.goto('/');
  const hero = page.locator('#hero');
  await expect(hero.locator('h1')).toHaveCount(1);
  await expect(hero.locator('.home-hero__lede')).toHaveCount(1);
  const links = await hero.locator('.home-hero__actions a').allTextContents();
  expect(links).toHaveLength(2);
  expect(new Set(links).size).toBe(2);
  const order = await hero.evaluate((section) => {
    const all = [...section.querySelectorAll('*')];
    return {
      actions: all.indexOf(section.querySelector('.home-hero__actions')!),
      toggle: all.indexOf(section.querySelector('[data-video-toggle]')!),
    };
  });
  expect(order.toggle).toBeGreaterThan(order.actions);
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
// clip keeps on the right, and the calls to action are on screen; the headline sets in two or three
// lines (round 2 spec §4.1.1).
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
    [2560, 1440],
  ] as const) {
    await page.setViewportSize({ width, height });
    const where = `${width}×${height}`;
    const hero = (await page.locator('.home-hero').boundingBox())!;
    const actions = (await page.locator('.home-hero__actions').boundingBox())!;
    // The text's right edge: its widest line, not its box; and the headline's line count.
    const { right, lines } = await page.evaluate(() => {
      const rects = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()];
      };
      return {
        right: Math.max(
          ...[...document.querySelectorAll('.home-hero__text > *')].flatMap(
            (element) => rects(element).map((rect) => rect.right),
          ),
        ),
        lines: new Set(
          rects(document.querySelector('.home-hero h1')!).map((rect) =>
            Math.round(rect.top),
          ),
        ).size,
      };
    });
    expect(hero.y + hero.height, where).toBeGreaterThanOrEqual(height - 1);
    expect(hero.width, where).toBe(width);
    expect(right, where).toBeLessThanOrEqual(width * 0.6);
    expect(actions.y + actions.height, where).toBeLessThanOrEqual(height);
    expect(lines, where).toBeGreaterThanOrEqual(2);
    expect(lines, where).toBeLessThanOrEqual(3);
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
        ...document.querySelectorAll(
          '.home-hero__text *, .hero-media__toggle svg',
        ),
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

// Round 2 spec §0.3 #15: a tablet held upright takes the tall framing, the globe kept in view.
test('portrait tablets frame the film for a tall screen (H-9) @desktop-chromium', async ({
  page,
}) => {
  for (const [width, height, position] of [
    [768, 1024, '61% 40%'],
    [820, 1180, '61% 40%'],
    [1180, 820, '62% 32%'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(
      page.locator('.hero-media__poster'),
      `${width}×${height}`,
    ).toHaveCSS('object-position', position);
  }
});

/**
 * H-7 (round 2 spec §8 item 7; rulings 22 and 26): every line of the hero's text holds 4.5:1 or more
 * against the brightest pixel behind it, over the poster and three frames of the film (seeked with
 * the motion hooks), and the Pause glyph holds 3:1 against the brightest pixel round it, its drop
 * shadow included (WCAG 1.4.11). A port of the hero build's contrast tool: the text is made
 * transparent, the hero photographed, each line box read for luminance.
 */
test('the hero’s text holds 4.5:1 and its Pause glyph 3:1 over the poster and the film (H-7)', async ({
  page,
  isMobile,
}) => {
  test.setTimeout(60_000);
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await playingFilm(page);
  await page.evaluate(() => window.__motion!.ready('hero-film'));
  const targets = [
    '.home-hero__kicker',
    '.home-hero h1',
    '.home-hero__lede',
    '.home-hero__actions .button-link--quiet',
  ];
  const lines = await page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const element = document.querySelector(selector)!;
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          selector,
          colour: getComputedStyle(element).color,
          rects: [...range.getClientRects()]
            .filter((rect) => rect.width > 2 && rect.height > 2)
            .map((rect) => [rect.left, rect.top, rect.width, rect.height]),
        };
      }),
    targets,
  );
  const glyph = await filmToggle(page).evaluate((button) => {
    const box = button.querySelector('svg')!.getBoundingClientRect();
    return [box.left, box.top, box.width];
  });
  const hide = await page.addStyleTag({
    content:
      '.home-hero__text * { color: transparent !important; text-shadow: none !important; }',
  });

  const read = async (frame: string) => {
    const png = await page.screenshot({ scale: 'css' });
    return page.evaluate(
      async ({ data, lines, glyph, frame }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const channel = (value: number) => {
          const v = value / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (r: number, g: number, b: number) =>
          0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        const ratio = (a: number, b: number) =>
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const failures: string[] = [];
        for (const { selector, colour, rects } of lines) {
          const [r, g, b] = colour.match(/\d+/g)!.map(Number);
          const text = luminance(r, g, b);
          let brightest = 0;
          for (const [x, y, w, h] of rects) {
            const left = Math.max(0, Math.floor(x));
            const top = Math.max(0, Math.floor(y));
            const width = Math.min(canvas.width, Math.ceil(x + w)) - left;
            const height = Math.min(canvas.height, Math.ceil(y + h)) - top;
            if (width <= 0 || height <= 0) continue;
            const pixels = context.getImageData(left, top, width, height).data;
            for (let index = 0; index < pixels.length; index += 4)
              brightest = Math.max(
                brightest,
                luminance(pixels[index], pixels[index + 1], pixels[index + 2]),
              );
          }
          const contrast = ratio(text, brightest);
          if (contrast < 4.5)
            failures.push(`${selector} ${contrast.toFixed(2)}:1 at ${frame}`);
        }
        // The glyph's two bars in its 20-unit box: their inside (inset 1) is the glyph's own colour;
        // the ring 1.5–3.5 px round them is what it is seen against, shadow included.
        const [gx, gy, size] = glyph;
        const unit = size / 20;
        const bars = [
          [5, 3.5, 8.2, 16.5],
          [11.8, 3.5, 15, 16.5],
        ].map(([x0, y0, x1, y1]) => [
          gx + x0 * unit,
          gy + y0 * unit,
          gx + x1 * unit,
          gy + y1 * unit,
        ]);
        const distance = (x: number, y: number) =>
          Math.min(
            ...bars.map(([x0, y0, x1, y1]) =>
              Math.hypot(
                Math.max(x0 - x, 0, x - x1),
                Math.max(y0 - y, 0, y - y1),
              ),
            ),
          );
        const inside = (x: number, y: number) =>
          bars.some(
            ([x0, y0, x1, y1]) =>
              x >= x0 + 1 && x <= x1 - 1 && y >= y0 + 1 && y <= y1 - 1,
          );
        let dimmest = 1;
        let ring = 0;
        const area = context.getImageData(
          Math.floor(gx - 6),
          Math.floor(gy - 6),
          Math.ceil(size + 12),
          Math.ceil(size + 12),
        );
        for (let row = 0; row < area.height; row += 1)
          for (let column = 0; column < area.width; column += 1) {
            const x = Math.floor(gx - 6) + column + 0.5;
            const y = Math.floor(gy - 6) + row + 0.5;
            const index = (row * area.width + column) * 4;
            const value = luminance(
              area.data[index],
              area.data[index + 1],
              area.data[index + 2],
            );
            if (inside(x, y)) dimmest = Math.min(dimmest, value);
            const away = distance(x, y);
            if (away >= 1.5 && away <= 3.5) ring = Math.max(ring, value);
          }
        const glyphContrast = ratio(dimmest, ring);
        if (glyphContrast < 3)
          failures.push(
            `Pause glyph ${glyphContrast.toFixed(2)}:1 at ${frame}`,
          );
        return failures;
      },
      { data: png.toString('base64'), lines, glyph, frame },
    );
  };

  const failures: string[] = [];
  // The poster: the film hidden.
  await filmVideo(page).evaluate((video: HTMLVideoElement) => {
    video.pause();
    video.style.opacity = '0';
  });
  await twoFrames(page);
  failures.push(...(await read('poster')));
  await filmVideo(page).evaluate((video: HTMLVideoElement) => {
    video.style.opacity = '1';
  });
  // Three frames of the loop where the hero build measured the brightest light behind the text.
  for (const ms of [11_000, 22_000, 52_000]) {
    await page.evaluate((t) => window.__motion!.seek('hero-film', t), ms);
    await twoFrames(page);
    failures.push(...(await read(`${ms / 1000} s`)));
  }
  await hide.evaluate((style) => (style as HTMLStyleElement).remove());
  expect(failures).toEqual([]);
});

/* ------------------------------------------------------------------ the Atlas preview */

const preview = (page: Page) =>
  page.locator('figure[data-graphic="atlas-preview"]');
const spinToggle = (page: Page) =>
  preview(page).getByRole('button', { name: 'Pause the rotation' });

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

/** Put the preview at `ms` of its scene (motion hooks): entrance, 5 s hold, then the turn. */
async function seekPreview(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => window.__motion!.seek('atlas-preview', t), ms);
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

interface LabelGeometry {
  kind: string;
  shown: boolean;
  opacity: number;
  plate: Box;
  ring: { x: number; y: number };
}

/** The labels as drawn: each plate and ring on screen, and whether the label shows. */
function labelGeometry(page: Page) {
  return page.evaluate(() => {
    const figure = document.querySelector('[data-graphic="atlas-preview"]')!;
    const globe = figure.querySelector('.hg-globe')!.getBoundingClientRect();
    const box = (element: Element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      disc: {
        x: globe.left + globe.width / 2,
        y: globe.top + globe.height / 2,
        r: globe.width / 2 / 1.04,
      },
      labels: [...figure.querySelectorAll<SVGGElement>('.hg-label')].map(
        (group) => {
          const ring = group
            .querySelector('.hg-label__ring')!
            .getBoundingClientRect();
          const opacity = Number(getComputedStyle(group).opacity);
          const off = group
            .querySelector('.hg-label__body')!
            .classList.contains('is-off');
          return {
            kind: group.dataset.label!,
            shown: opacity > 0 && !off,
            opacity,
            plate: box(group.querySelector('.hg-label__plate')!),
            ring: {
              x: ring.left + ring.width / 2,
              y: ring.top + ring.height / 2,
            },
          };
        },
      ),
    };
  });
}

/** Ruling 23's rules for the labels on screen now: each beside its own point, inside the disc, none
 * over another label or another point. */
function labelRules(
  where: string,
  disc: { x: number; y: number; r: number },
  labels: LabelGeometry[],
): string[] {
  const failures: string[] = [];
  const shown = labels.filter((label) => label.shown);
  for (const label of shown) {
    const { plate, ring } = label;
    for (const [x, y] of [
      [plate.left, plate.top],
      [plate.right, plate.top],
      [plate.left, plate.bottom],
      [plate.right, plate.bottom],
    ])
      if (Math.hypot(x - disc.x, y - disc.y) > disc.r + 0.5)
        failures.push(`${where}: ${label.kind} leaves the disc`);
    // Beside its point: the plate's nearest edge 10 px (beside) to 13 px (below or above) from
    // the ring's centre, clear of the ring (6 px) and never farther.
    const near = Math.hypot(
      Math.max(plate.left - ring.x, 0, ring.x - plate.right),
      Math.max(plate.top - ring.y, 0, ring.y - plate.bottom),
    );
    if (near < 6.5 || near > 13.5)
      failures.push(
        `${where}: ${label.kind}'s plate is ${near.toFixed(1)} px from its point`,
      );
    for (const other of shown.filter((entry) => entry !== label)) {
      if (overlaps(plate, other.plate))
        failures.push(`${where}: ${label.kind} overlaps ${other.kind}`);
      const ringBox = {
        left: other.ring.x - 6,
        right: other.ring.x + 6,
        top: other.ring.y - 6,
        bottom: other.ring.y + 6,
      };
      if (overlaps(plate, ringBox))
        failures.push(`${where}: ${label.kind} covers ${other.kind}'s point`);
    }
  }
  return failures;
}

test('the preview turns slowly by itself after a hold on its starting view, and stops off screen', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await expect(figure).toHaveAttribute('data-view', 'rest');
  await expect(figure).toHaveAttribute('data-spin', 'waiting');
  const still = await canvasPixels(page);
  await page.clock.runFor(4500);
  expect(await canvasPixels(page)).toBe(still);

  await page.clock.runFor(1000);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  await page.clock.runFor(2000);
  expect(await canvasPixels(page)).not.toBe(still);
  await expect(figure).toHaveAttribute('data-view', 'moved');
  await expect(spinToggle(page)).toBeVisible();

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

test('no animation frame is asked for after Pause, off screen, in a hidden tab or in poster mode (G-1)', async ({
  page,
}) => {
  const start = new Date('2026-10-14T12:00:00Z');
  await page.clock.install({ time: start });
  await instrumentFrames(page);
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto('/');
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  await expect(async () => {
    await page.clock.fastForward(250);
    await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 100,
    });
  }).toPass({ timeout: 15_000 });
  // Every other figure on screen rests by now; the rotation starts after its 5 s hold.
  await page.clock.runFor(6000);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  // Anything else scrolled into view (other figures' entrances, at most 3 s) settles first.
  const quiet = async (label: string) => {
    await page.clock.runFor(4000);
    const before = await frameCount(page);
    await page.clock.runFor(2000);
    const after = await frameCount(page);
    expect(after.requested - before.requested, `${label}: frames`).toBe(0);
    expect(after.pending, `${label}: pending`).toBe(0);
  };

  await spinToggle(page).click();
  await page.mouse.move(2, 2);
  await expect(figure).toHaveAttribute('data-spin', 'paused');
  await expect(spinToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await quiet('after Pause');
  await spinToggle(page).click();
  await page.mouse.move(2, 2);
  await expect(figure).toHaveAttribute('data-spin', 'running');

  await page.evaluate(() =>
    window.scrollTo({ top: 99_999, behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-spin', 'stopped');
  await quiet('off screen');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-spin', 'running');

  await setHidden(page, true);
  await expect(figure).toHaveAttribute('data-spin', 'stopped');
  await quiet('in a hidden tab');
});

test('reduced motion and poster mode ask for no frame for the preview (G-1)', async ({
  page,
}) => {
  await instrumentFrames(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true, effectiveType: '4g', addEventListener() {} },
    });
  });
  await page.goto('/');
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-mode', 'poster');
  await expect(figure).toHaveAttribute('data-spin', 'off');
  await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
  // Save-Data: no figure data is fetched, and the labels stay on the poster.
  for (const kind of ['survey', 'modeled', 'unknown'])
    await expect(
      figure.locator(`.hg-label[data-label="${kind}"] .hg-label__body`),
    ).not.toHaveClass(/is-off/);

  const reduced = await page.context().newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await instrumentFrames(reduced);
  await reduced.goto('/');
  const still = await livePreview(reduced);
  await reduced.waitForTimeout(1500);
  const before = await frameCount(reduced);
  await reduced.waitForTimeout(1500);
  const after = await frameCount(reduced);
  expect(after.requested - before.requested).toBe(0);
  await expect(still).toHaveAttribute('data-spin', 'off');
  await reduced.close();
});

test('pointing at or focusing the figure eases it to a stop; it turns again 4 s after (G-2) @desktop-chromium', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await page.clock.runFor(5500);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  const globe = figure.locator('.hg-globe');
  await globe.hover();
  await expect(figure).toHaveAttribute('data-spin', 'held');
  // A 400 ms ease to a stop, then nothing moves.
  await page.clock.runFor(500);
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

  // Keyboard focus anywhere in the figure holds it the same way.
  await figure.locator('.hg-layers button').first().focus();
  await expect(figure).toHaveAttribute('data-spin', 'held');
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

test('the rotation’s Pause is a white glyph that stops it until Play, whatever the visitor does', async ({
  page,
}) => {
  const figure = await previewOnClock(page);
  await page.clock.runFor(5500);
  const toggle = spinToggle(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('data-state', 'playing');
  // Ruling 22: no background, no border, no visible words; a 44 px target.
  expect(
    await toggle.evaluate((button) => {
      const style = getComputedStyle(button);
      return [style.backgroundColor, style.borderTopWidth, style.color];
    }),
  ).toEqual(['rgba(0, 0, 0, 0)', '0px', 'rgb(242, 248, 255)']);
  const box = (await toggle.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await page.mouse.move(2, 2);
  await expect(figure).toHaveAttribute('data-spin', 'paused');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('data-state', 'paused');
  await expect(toggle.locator('.kit-scene-control__play')).toBeVisible();
  const paused = await canvasPixels(page);
  await figure.locator('.hg-globe').focus();
  await figure.locator('.hg-globe').blur();
  await page.clock.runFor(15_000);
  await expect(figure).toHaveAttribute('data-spin', 'paused');
  expect(await canvasPixels(page)).toBe(paused);
  await toggle.click();
  await page.mouse.move(2, 2);
  await expect(figure).toHaveAttribute('data-spin', 'running');
  await page.clock.runFor(1500);
  expect(await canvasPixels(page)).not.toBe(paused);
});

test('reduced motion: the preview rests at once with every label, never turns, and offers no Pause', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const figure = await previewOnClock(page);
  await expect(figure.locator('.hg-label__body.is-off')).toHaveCount(0);
  const still = await canvasPixels(page);
  await page.clock.runFor(30_000);
  await expect(figure).toHaveAttribute('data-spin', 'off');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  expect(await canvasPixels(page)).toBe(still);
  await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
  // The globe still turns when asked, at once.
  await figure.locator('.hg-globe').focus();
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');
});

test('the preview says what it is, and its pill opens the same map in the genomeOS Atlas (G-6)', async ({
  page,
}) => {
  await page.goto('/');
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  // Ruling R2-14: a plain note, never a status tag.
  await expect(figure.locator('.kit-status-tag')).toHaveCount(0);
  await expect(figure).not.toContainText('Not yet validated');
  await expect(figure.locator('.figure-note p')).toHaveText(
    'A simplified preview, made from a sample of real Atlas data.',
  );
  const open = figure.getByRole('link', { name: 'Open the genomeOS Atlas' });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute(
    'href',
    '/app/?entity=hbs-rs334&palette=genome',
  );
  const box = (await open.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // The wordmark type, as every visible genomeOS.
  await expect(open.locator('.brand-name')).toHaveText('genomeOS');
  // The footnote is provenance only.
  await expect(figure.locator('.kit-figure__footnote a')).toHaveCount(0);
  // One control besides it: the Measured · Modeled toggle (and the rotation's Pause).
  const layers = figure.getByRole('group', { name: 'Layer' });
  await expect(layers.getByRole('button')).toHaveText(['Measured', 'Modeled']);
  await expect(
    figure.locator('.hg-step, [data-readout], .hg-reset'),
  ).toHaveCount(0);
});

test('the legend leads with what the globe shows, on its first line at 390 px (G-5) @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const legend = preview(page).locator('figcaption');
  await legend.scrollIntoViewIfNeeded();
  const lead = legend.locator('.hg-legend__lead');
  await expect(lead).toHaveText('Shown: the sickle-cell variant, HbS.');
  const leadBox = (await lead.boundingBox())!;
  const keys = await legend
    .locator('[data-legend="modeled"] .hg-key')
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().top),
    );
  for (const top of keys)
    expect(top).toBeGreaterThanOrEqual(leadBox.y + leadBox.height - 0.5);
  // One line: its height is one line box.
  const lineHeight = await lead.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(leadBox.height).toBeLessThan(lineHeight * 1.5);
});

test('the layer control has one pressed layer, swaps the legend and the labels', async ({
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
  // The Measured layer draws no estimates, so the Modeled label names nothing on it; the hatch
  // for areas with no estimate is drawn on both layers, so its label stays (review of T1).
  const body = (kind: string) =>
    figure.locator(`.hg-label[data-label="${kind}"] .hg-label__body`);
  await expect(body('survey')).not.toHaveClass(/is-off/);
  await expect(body('modeled')).toHaveClass(/is-off/);
  await expect(body('unknown')).not.toHaveClass(/is-off/);
  // Screen readers keep all three.
  await expect(figure.locator('#atlas-preview-labels li')).toHaveCount(3);
  await layers.getByRole('button', { name: 'Modeled' }).click();
  await expect(body('modeled')).not.toHaveClass(/is-off/);
});

// Ruling 23: at the starting view every label shows beside its own point (G-3), and as the globe
// turns each rides with its point, fades away as the point turns from the viewer, never leaves the
// disc and never covers another label or point.
test('the labels sit beside their points at rest and keep to the rules as the globe turns (G-3)', async ({
  page,
}) => {
  await page.goto('/');
  await livePreview(page);
  await seekPreview(page, 2800);
  const rest = await labelGeometry(page);
  expect(rest.labels.map((label) => [label.kind, label.shown])).toEqual([
    ['survey', true],
    ['modeled', true],
    ['unknown', true],
  ]);
  for (const label of rest.labels) expect(label.opacity).toBe(1);
  expect(labelRules('rest', rest.disc, rest.labels)).toEqual([]);
  // The labels light as their marks arrive.
  await seekPreview(page, 1500);
  const early = await labelGeometry(page);
  expect(early.labels.map((label) => label.shown)).toEqual([
    true,
    false,
    false,
  ]);

  const failures: string[] = [];
  const seen = new Set<string>();
  const gone = new Set<string>();
  for (let ms = 7800; ms <= 60_000; ms += 2000) {
    await seekPreview(page, ms);
    const { disc, labels } = await labelGeometry(page);
    failures.push(...labelRules(`${ms} ms`, disc, labels));
    for (const label of labels) (label.shown ? seen : gone).add(label.kind);
  }
  expect(failures).toEqual([]);
  // Every label is seen turning and every one goes behind the globe at some point.
  expect([...seen].sort()).toEqual(['modeled', 'survey', 'unknown']);
  expect([...gone].sort()).toEqual(['modeled', 'survey', 'unknown']);
  // The words stay for screen readers throughout.
  await expect(preview(page).locator('#atlas-preview-labels li')).toHaveCount(
    3,
  );
});

test('a label fades as its point turns away, and comes back with it', async ({
  page,
}) => {
  await page.goto('/');
  await livePreview(page);
  const survey = async (ms: number) => {
    await seekPreview(page, ms);
    return (await labelGeometry(page)).labels.find(
      (label) => label.kind === 'survey',
    )!;
  };
  // The survey's point (7.4°N 3.9°E) turns past 60° from the view centre about 74° into the turn
  // and is gone by 87°: at 4°/s after the hold, about 27.6 s and 31 s into the scene.
  expect((await survey(20_000)).opacity).toBe(1);
  const fading = await survey(28_800);
  expect(fading.opacity).toBeGreaterThan(0.05);
  expect(fading.opacity).toBeLessThan(0.95);
  expect((await survey(34_000)).opacity).toBe(0);
  // A full turn later it is back.
  expect((await survey(20_000 + 90_000)).opacity).toBe(1);
});

test('turns 4° a second: two seeks 10 s apart in the turn differ by 40° (G-4)', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  const lon = async (ms: number) => {
    await seekPreview(page, ms);
    return Number(await figure.getAttribute('data-view-lon'));
  };
  const first = await lon(12_000);
  const second = await lon(22_000);
  // The centre's longitude falls: features drift west to east, as the Earth turns.
  const turned = (((first - second) % 360) + 360) % 360;
  expect(turned).toBeGreaterThan(39);
  expect(turned).toBeLessThan(41);
});

test('arrow keys turn the focused globe, the labels following, and Home returns it to its starting view', async ({
  page,
}) => {
  await page.goto('/');
  const figure = await livePreview(page);
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  const before = (await labelGeometry(page)).labels;
  await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'moved');
  const after = await labelGeometry(page);
  // The labels ride with their points.
  expect(after.labels[0].ring.x).not.toBeCloseTo(before[0].ring.x, 0);
  expect(labelRules('one key', after.disc, after.labels)).toEqual([]);
  // Turned the Earth's way far enough (the centre's longitude falling), the No-estimate point
  // (Central Asia) leaves the visible face, and its label with it.
  for (let press = 0; press < 7; press += 1)
    await page.keyboard.press('ArrowLeft');
  const far = await labelGeometry(page);
  expect(far.labels.find((label) => label.kind === 'unknown')!.shown).toBe(
    false,
  );
  expect(labelRules('seven keys', far.disc, far.labels)).toEqual([]);
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  const home = await labelGeometry(page);
  expect(home.labels.every((label) => label.shown)).toBe(true);
});

// Ruling 25: the labels fade by design, so axe must pass at any instant, mid-fade included.
test('axe finds nothing serious on Home while the labels light, turn and fade', async ({
  page,
}) => {
  await page.goto('/');
  // The moment the island arms the figure (the flaky phone case before ruling 25).
  await preview(page).scrollIntoViewIfNeeded();
  const scan = async (where: string) => {
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    const blocking = results.violations
      .filter(({ impact }) => ['serious', 'critical'].includes(impact ?? ''))
      .map(
        ({ id, nodes }) =>
          `${where}: ${id} ${nodes.map((node) => node.target).join(' ')}`,
      );
    expect(blocking).toEqual([]);
  };
  await scan('arming');
  await livePreview(page);
  // Mid-entrance (label 2 lighting), and a label half faded as its point turns away.
  for (const ms of [2450, 28_800]) {
    await seekPreview(page, ms);
    await scan(`${ms} ms`);
  }
});

// The Modeled label marks modeling (owner review, round 2): on screen, no stud is near its point.
test('the Modeled point stands clear of every measured stud @desktop-chromium', async ({
  page,
}) => {
  // At rest, so the point stays where the build placed it.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await livePreview(page);
  const label = page.locator('#atlas-preview .hg-label[data-label="modeled"]');
  const ring = label.locator('.hg-label__ring');
  const box = (await ring.boundingBox())!;
  // The studs are white: twice the ring's width around it holds none of their pixels once the
  // label itself is hidden.
  const clip = {
    x: box.x - box.width / 2,
    y: box.y - box.height / 2,
    width: box.width * 2,
    height: box.height * 2,
  };
  const crop = await page.screenshot({ clip });
  await label.evaluate((element) => {
    (element as SVGGElement).style.visibility = 'hidden';
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

test('dragging turns the globe and its labels; Home brings it back @desktop-chromium', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const figure = await livePreview(page);
  const globe = figure.locator('.hg-globe');
  const box = (await globe.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = (await labelGeometry(page)).labels;
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 4 });
  await page.mouse.move(centre.x + 140, centre.y, { steps: 4 });
  await page.mouse.up();
  await expect(figure).toHaveAttribute('data-view', 'moved');
  const after = await labelGeometry(page);
  expect(after.labels[0].ring.x).toBeGreaterThan(before[0].ring.x + 20);
  expect(labelRules('dragged', after.disc, after.labels)).toEqual([]);
  await globe.focus();
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-view', 'rest');
});

test('at 320 px the layer segments and the Pause glyph stay inside their row @mobile-chromium', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  const figure = await livePreview(page);
  await expect(figure.locator('[data-scene-toggle]')).toBeVisible();
  const toolbar = (await figure.locator('.kit-figure__toolbar').boundingBox())!;
  const group = figure.getByRole('group', { name: 'Layer' });
  for (const button of [
    ...(await group.getByRole('button').all()),
    figure.locator('[data-scene-toggle]'),
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
  // And the labels fit the smallest disc.
  const { disc, labels } = await labelGeometry(page);
  expect(labels.every((label) => label.shown)).toBe(true);
  expect(labelRules('320 px', disc, labels)).toEqual([]);
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
  await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
  await expect(figure.locator('[data-legend="modeled"]')).toBeVisible();
  await expect(figure.locator('[data-legend="measured"]')).toBeHidden();
  const globe = figure.locator('.hg-globe');
  await globe.focus();
  for (let press = 0; press < 3; press += 1)
    await page.keyboard.press('ArrowRight');
  await expect(figure).toHaveAttribute('data-view', 'rest');
  for (const plate of await figure.locator('.hg-label__plate').all())
    await expect(plate).toBeVisible();
  await expect(figure.locator('.hg-label__body.is-off')).toHaveCount(0);
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
// its legend and its labels at rest, never a turned view or a control.
test('printing after a layer switch and a turn shows the poster’s own legend and labels', async ({
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
  for (const control of ['.hg-layers', '[data-scene-toggle]'])
    await expect(figure.locator(control), control).toBeHidden();
  // The labels back at the starting view, all three shown.
  await expect(figure).toHaveAttribute('data-view', 'rest');
  const { disc, labels } = await labelGeometry(page);
  expect(labels.every((label) => label.shown)).toBe(true);
  expect(labelRules('print', disc, labels)).toEqual([]);
  await expect(page.locator('.hero-media__video')).toBeHidden();
  await expect(page.locator('[data-video-toggle]')).toBeHidden();
});

test('without JavaScript the labels sit at their points on the poster', async ({
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
  const figure = preview(page);
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.locator('.hg-poster')).toBeVisible();
  const { disc, labels } = await labelGeometry(page);
  expect(labels.every((label) => label.shown)).toBe(true);
  expect(labelRules('no JavaScript', disc, labels)).toEqual([]);
  // Each ring sits on its point: the sidecar's place on the disc.
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>('.hg-label')].map((group) =>
      group.style.getPropertyValue('--lx'),
    ),
  );
  expect(expected.every((value) => value.endsWith('%'))).toBe(true);
  await context.close();
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
