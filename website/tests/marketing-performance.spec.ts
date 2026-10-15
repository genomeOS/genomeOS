/**
 * Marketing page budgets (site redesign spec §7, §9.2–§9.3; #454), under
 * playwright.performance.config.ts against the deployed build (`npm run build:deployed`), in the
 * Pages workflow's performance job.
 *
 * Gzip transfer by type, LCP and CLS, on a desktop profile and a phone profile (Pixel 7 viewport,
 * 4× CPU, Slow 4G), from each finished page's manifest. Round 2 (spec §7) splits what a visitor
 * downloads by when:
 *
 *   initial   everything from navigation until network idle without scrolling, the film left
 *             out: first-load JS (`jsKbGz`), images (`imagesKbGz`), the total (`transferKbGz`)
 *   lazy      each module imported as its figure approaches, by chunk name (`lazyJsKbGz`); every
 *             one the manifest names must load once every figure has been in view (a page not
 *             enforced yet only logs the ones that did not)
 *   deferred  figure data fetched near view (`dataKbGz`), and a hero film (`deferredMediaKb`,
 *             per profile), which must not start before the load event
 *
 * Every marketing route is also held to no Cesium, no React, no GSAP, no Lottie and no
 * third-party request.
 *
 * The rulings of 2026-10-14 (spec §7):
 *   10  The budgets measure what visitors download: a build with an analytics id. Google
 *       Analytics itself never loads (consent is declined), so it is still left out; the cookie
 *       control is in. A build without an id is refused, not measured.
 *   11  The cookie control is site chrome, like the fonts: page JS budgets leave it out, and it
 *       is held to its own budget once per route.
 *   13  The Pages workflow's performance job runs this. The byte budgets (JS, data, transfer)
 *       are exact. LCP and CLS are enforced too: with every profile's CPU slowed a further 2.5×
 *       (PERF_CPU_SCALE=2.5, a stand-in for a slower runner) the worst phone LCP was 1,452 ms of
 *       2,500 and the worst desktop LCP 128 ms of 1,000, and CLS did not move. If runners prove
 *       noisier than that, PERF_TIMING=log keeps them measured and logged but not enforced
 *       (spec §7).
 */
import { expect, test, type Page } from '@playwright/test';

import {
  fullyEnforced,
  pageManifests,
  type PageManifest,
} from './helpers/pages';
import { marketingRoutes } from './site-routes';

interface Measured {
  /** First-load first-party JS (before any scrolling), without the cookie control (ruling 11). */
  jsKb: number;
  /** JS by chunk name (the file name before its hash), wherever in the visit it loaded. */
  chunksKb: Record<string, number>;
  /** The cookie control's module and the modules it imports. */
  cookieKb: number;
  cookieUrls: string[];
  dataKb: number;
  /** Images in the initial transfer. */
  imageKb: number;
  /** The deferred hero film: KB as transferred, and when each file started after the load event. */
  videoKb: number;
  videos: { name: string; afterLoadMs: number }[];
  /** Why a hero film kept its poster (reduced motion, Save-Data, 3g…), or null. */
  filmReason: string | null;
  totalKb: number;
  lcpMs: number;
  cls: number;
  urls: string[];
}

/** The cookie control's own budget, gzip KB, on every route (spec §7, ruling 11). */
const COOKIE_CONTROL_KB_GZ = 3.6;

/** `PERF_TIMING=log`: measure and log LCP and CLS without enforcing them (ruling 13's fallback). */
const TIMING_ENFORCED = process.env.PERF_TIMING !== 'log';

/**
 * Extra CPU slowdown on top of each profile's own (`PERF_CPU_SCALE`, default 1): a stand-in for a
 * slower machine, used to see how much headroom the timing budgets have (ruling 13).
 */
const CPU_SCALE = Number(process.env.PERF_CPU_SCALE ?? '1');

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, cpu: 1, network: null },
  phone: {
    viewport: { width: 412, height: 839 },
    cpu: 4,
    // Slow 4G as Lighthouse defines it: 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up.
    network: {
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 93_750,
    },
  },
} as const;

async function measure(
  page: Page,
  route: string,
  profile: keyof typeof PROFILES,
): Promise<Measured> {
  const { viewport, cpu, network } = PROFILES[profile];
  await page.setViewportSize(viewport);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu * CPU_SCALE });
  if (network)
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      ...network,
    });
  await page.addInitScript(() => {
    // Analytics declined, so nothing loads before consent (spec §7: GA excluded).
    localStorage.setItem('genomeos-analytics-consent', 'denied');
    const state = { lcp: 0, cls: 0 };
    (window as unknown as { __perf: typeof state }).__perf = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!entry.hadRecentInput) state.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(route, { waitUntil: 'load' });
  // The initial transfer: what arrives before the visitor scrolls.
  await page.waitForLoadState('networkidle');
  const initialCount = await page.evaluate(
    () => performance.getEntriesByType('resource').length,
  );
  // Bring every figure into view, so deferred data loads as a visitor would load it.
  await page.evaluate(async () => {
    for (const figure of document.querySelectorAll(
      'main figure[data-graphic]',
    )) {
      figure.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForLoadState('networkidle');
  // A hero film that started is measured whole: its timing entry lands when its download ends,
  // which streaming paces to playback (tens of seconds for the minute-long film). One kept on its poster (its reason says why) loads
  // nothing.
  const film = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-hero-media]');
    return root
      ? { state: root.dataset.video ?? '', reason: root.dataset.videoReason }
      : null;
  });
  if (film && film.state !== 'poster')
    await page.waitForFunction(
      () =>
        performance
          .getEntriesByType('resource')
          .some(
            (entry) =>
              (entry as PerformanceResourceTiming).initiatorType === 'video',
          ),
      null,
      { timeout: 45_000 },
    );
  const filmReason = film?.reason ?? null;
  const measured = await page.evaluate(async (initialCount) => {
    const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;
    // Read the timing first: fetching the control's sources below adds entries of its own.
    const entries = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
    const initialEntries = new Set(entries.slice(0, initialCount));
    // The cookie control: its module script and, transitively, the modules it imports.
    const control = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="CookieControl.astro_astro_type_script"]',
    );
    if (!control)
      throw new Error(
        'This build has no cookie control, so it loads no analytics: the budgets measure the deployed build (ruling 10). Build with `npm run build:deployed`.',
      );
    const cookieUrls = new Set<string>();
    const pending = [control.src];
    while (pending.length) {
      const url = pending.pop()!;
      if (cookieUrls.has(url)) continue;
      cookieUrls.add(url);
      const source = await (await fetch(url)).text();
      for (const [, specifier] of source.matchAll(
        /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g,
      ))
        pending.push(new URL(specifier!, url).href);
    }
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    const firstParty = entries.filter(
      (entry) =>
        new URL(entry.name).origin === location.origin &&
        !entry.name.includes('googletagmanager'),
    );
    const sum = (list: PerformanceResourceTiming[]) =>
      list.reduce(
        (total, entry) => total + (entry.transferSize || entry.encodedBodySize),
        0,
      );
    const scripts = firstParty.filter((entry) =>
      /\.m?js(\?|$)/.test(entry.name),
    );
    const cookie = scripts.filter((entry) => cookieUrls.has(entry.name));
    const js = scripts.filter(
      (entry) => !cookieUrls.has(entry.name) && initialEntries.has(entry),
    );
    const chunks: Record<string, number> = {};
    for (const entry of scripts) {
      const name = new URL(entry.name).pathname
        .split('/')
        .pop()!
        .replace(/\.[\w-]+\.m?js$/, '');
      chunks[name] =
        (chunks[name] ?? 0) + (entry.transferSize || entry.encodedBodySize);
    }
    const data = firstParty.filter((entry) =>
      /\/_astro\/hbs-[^/]+\.bin(\?|$)/.test(entry.name),
    );
    const images = firstParty.filter(
      (entry) => entry.initiatorType === 'img' && initialEntries.has(entry),
    );
    // The hero film: deferred past the load event, budgeted on its own, out of the total.
    const videos = firstParty.filter(
      (entry) => entry.initiatorType === 'video',
    );
    const initial = firstParty.filter(
      (entry) => !videos.includes(entry) && initialEntries.has(entry),
    );
    const state = (
      window as unknown as { __perf: { lcp: number; cls: number } }
    ).__perf;
    return {
      jsKb: kb(sum(js)),
      chunksKb: Object.fromEntries(
        Object.entries(chunks).map(([name, bytes]) => [name, kb(bytes)]),
      ),
      cookieKb: kb(sum(cookie)),
      cookieUrls: [...cookieUrls],
      dataKb: kb(sum(data)),
      imageKb: kb(sum(images)),
      videoKb: kb(sum(videos)),
      videos: videos.map((entry) => ({
        name: new URL(entry.name).pathname,
        afterLoadMs: Math.round(
          entry.startTime - (navigation?.loadEventEnd ?? 0),
        ),
      })),
      totalKb: kb(sum(initial) + (navigation?.transferSize ?? 0)),
      lcpMs: Math.round(state.lcp),
      cls: Math.round(state.cls * 1000) / 1000,
      urls: entries.map((entry) => entry.name),
    };
  }, initialCount);
  return { ...measured, filmReason };
}

/**
 * The lazy modules a manifest names that never loaded. measure() brings every figure into view
 * first, so a module missing here was never imported, or its chunk has another name.
 */
const lazyMisses = (manifest: PageManifest, measured: Measured) =>
  Object.keys(manifest.lazyJsKbGz ?? {}).filter(
    (chunk) => !(chunk in measured.chunksKb),
  );
const loadedChunks = (measured: Measured) =>
  Object.keys(measured.chunksKb).sort().join(', ') || 'none';

function expectBudgets(
  manifest: PageManifest,
  measured: Measured,
  profile: string,
) {
  const label = `${manifest.route} (${profile})`;
  if (manifest.jsKbGz !== null)
    expect(measured.jsKb, `${label} JS`).toBeLessThanOrEqual(manifest.jsKbGz);
  if (manifest.dataKbGz !== null)
    expect(measured.dataKb, `${label} figure data`).toBeLessThanOrEqual(
      manifest.dataKbGz,
    );
  if (manifest.transferKbGz !== null)
    expect(measured.totalKb, `${label} transfer`).toBeLessThanOrEqual(
      manifest.transferKbGz,
    );
  if (manifest.imagesKbGz !== undefined)
    expect(measured.imageKb, `${label} initial images`).toBeLessThanOrEqual(
      manifest.imagesKbGz,
    );
  // A lazy module loads as its figure approaches, and every figure has been in view by now.
  expect(
    lazyMisses(manifest, measured),
    `${label} lazy modules that never loaded once every figure was in view (the chunks that did: ${loadedChunks(measured)})`,
  ).toEqual([]);
  for (const [chunk, budget] of Object.entries(manifest.lazyJsKbGz ?? {}))
    expect(
      measured.chunksKb[chunk],
      `${label} lazy module ${chunk}`,
    ).toBeLessThanOrEqual(budget);
  if (manifest.deferredMediaKb !== undefined) {
    // The desktop profile always plays the film (no reduced motion, Save-Data or slow
    // connection), so the budget is always exercised; a profile on which the page keeps its poster
    // must then load none. A film that loads waits for the load event.
    if (profile === 'desktop')
      expect(measured.filmReason, `${label} film plays`).toBeNull();
    if (measured.filmReason)
      expect(measured.videos, `${label} film kept on its poster`).toEqual([]);
    else expect(measured.videos.length, `${label} film`).toBeGreaterThan(0);
    for (const video of measured.videos)
      expect(
        video.afterLoadMs,
        `${label} ${video.name} starts after load`,
      ).toBeGreaterThanOrEqual(0);
    expect(measured.videoKb, `${label} film`).toBeLessThanOrEqual(
      manifest.deferredMediaKb[profile === 'desktop' ? 'desktop' : 'phone'],
    );
  } else expect(measured.videos, `${label} loads no film`).toEqual([]);
  if (profile === 'desktop') {
    expect(
      measured.cookieKb,
      `${label} cookie control (site chrome, ruling 11)`,
    ).toBeLessThanOrEqual(COOKIE_CONTROL_KB_GZ);
    // Every file of the control was fetched: an empty sum would pass the budget unmeasured.
    expect(measured.cookieKb, `${label} cookie control`).toBeGreaterThan(0);
  }
  if (!TIMING_ENFORCED) return;
  if (manifest.lcpMs)
    expect(measured.lcpMs, `${label} LCP`).toBeLessThanOrEqual(
      profile === 'desktop' ? manifest.lcpMs.desktop : manifest.lcpMs.phone,
    );
  expect(measured.cls, `${label} CLS`).toBeLessThanOrEqual(manifest.cls);
}

for (const manifest of fullyEnforced.filter((page) => !page.redirect))
  for (const profile of ['desktop', 'phone'] as const)
    test(`${manifest.route} meets its ${profile} budgets`, async ({ page }) => {
      // The hero film streams as it plays (about a minute at a quarter speed), so it arrives whole
      // well after the load event; measure() waits for it.
      test.setTimeout(90_000);
      const measured = await measure(page, manifest.route, profile);
      console.log(
        `budgets ${manifest.route} ${profile}: ${JSON.stringify({ ...measured, urls: undefined, cookieUrls: undefined })}`,
      );
      expectBudgets(manifest, measured, profile);
    });

for (const route of marketingRoutes)
  test(`${route} requests no Cesium, no React, no GSAP or Lottie, and nothing third-party`, async ({
    page,
  }) => {
    // The same measurement as the budgets, which waits for a streaming hero film to arrive whole.
    test.setTimeout(90_000);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    const measured = await measure(page, route, 'desktop');
    // A page whose task is still under way is not held to its lazy modules yet (the budgets test
    // holds enforced pages to them): say which never loaded.
    const manifest = pageManifests.find((entry) => entry.route === route);
    if (manifest && !fullyEnforced.includes(manifest)) {
      const missing = lazyMisses(manifest, measured);
      if (missing.length)
        console.log(
          `lazy modules ${route} (not enforced yet): ${missing.join(', ')} never loaded once every figure was in view; the chunks that did: ${loadedChunks(measured)}`,
        );
    }
    const origin = new URL(page.url()).origin;
    for (const url of requests) {
      expect(new URL(url).origin, url).toBe(origin);
      expect(url, url).not.toMatch(/cesium|react|gsap|lottie/i);
    }
  });
