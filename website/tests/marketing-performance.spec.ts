/**
 * Marketing page budgets (site redesign spec §7, §9.2–§9.3; #454), under
 * playwright.performance.config.ts against a production build, in CI only.
 *
 * Gzip transfer by type (first-party JS, deferred figure data, images, total), LCP and CLS, on a
 * desktop profile and a phone profile (Pixel 7 viewport, 4× CPU, Slow 4G), from each finished
 * page's manifest. Google Analytics is left out: it loads only after consent. Every marketing
 * route is also held to no Cesium, no React and no third-party request.
 */
import { expect, test, type Page } from '@playwright/test';

import { fullyEnforced, type PageManifest } from './helpers/pages';
import { marketingRoutes } from './site-routes';

interface Measured {
  jsKb: number;
  dataKb: number;
  imageKb: number;
  totalKb: number;
  lcpMs: number;
  cls: number;
  urls: string[];
}

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
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
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
  return page.evaluate(() => {
    const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;
    const entries = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
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
    const js = firstParty.filter((entry) => /\.m?js(\?|$)/.test(entry.name));
    const data = firstParty.filter((entry) =>
      /\/_astro\/hbs-[^/]+\.bin(\?|$)/.test(entry.name),
    );
    const images = firstParty.filter((entry) => entry.initiatorType === 'img');
    const state = (
      window as unknown as { __perf: { lcp: number; cls: number } }
    ).__perf;
    return {
      jsKb: kb(sum(js)),
      dataKb: kb(sum(data)),
      imageKb: kb(sum(images)),
      totalKb: kb(sum(firstParty) + (navigation?.transferSize ?? 0)),
      lcpMs: Math.round(state.lcp),
      cls: Math.round(state.cls * 1000) / 1000,
      urls: entries.map((entry) => entry.name),
    };
  });
}

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
  if (manifest.lcpMs)
    expect(measured.lcpMs, `${label} LCP`).toBeLessThanOrEqual(
      profile === 'desktop' ? manifest.lcpMs.desktop : manifest.lcpMs.phone,
    );
  expect(measured.cls, `${label} CLS`).toBeLessThanOrEqual(manifest.cls);
}

for (const manifest of fullyEnforced.filter((page) => !page.redirect))
  for (const profile of ['desktop', 'phone'] as const)
    test(`${manifest.route} meets its ${profile} budgets`, async ({ page }) => {
      const measured = await measure(page, manifest.route, profile);
      console.log(
        `budgets ${manifest.route} ${profile}: ${JSON.stringify({ ...measured, urls: undefined })}`,
      );
      expectBudgets(manifest, measured, profile);
    });

for (const route of marketingRoutes)
  test(`${route} requests no Cesium, no React and nothing third-party`, async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await measure(page, route, 'desktop');
    const origin = new URL(page.url()).origin;
    for (const url of requests) {
      expect(new URL(url).origin, url).toBe(origin);
      expect(url, url).not.toMatch(/cesium|react/i);
    }
  });
