/**
 * The World Terrain budgets of the draped data, measured and reported (terrain draping design,
 * "Performance budget and measurement"; Atlas design §11; #483). Report-only until phase 4, which
 * asserts them on hardware GPUs; here the only claim is that the draped tiles arrived.
 *
 * CI has no Cesium ion token, so the e2e build stands its synthetic terrain in for World Terrain
 * (src/atlas/e2e-hooks.ts) and publishes the drape stats as `window.__atlasDrapeStats`. So this
 * spec runs under playwright.config.ts with the e2e build, not under
 * playwright.performance.config.ts, which asserts a production build. It runs in both projects:
 * the desktop switches to World Terrain in the chooser, and the phone, its CPU slowed ×4, cold
 * loads `terrain=world-terrain`. Both then restyle the surface, pan for 3 s and read the stats.
 */

import { expect, test, type Page } from '@playwright/test';

import { expandExplorerSheet, setSheetState } from './atlas-mobile-helpers';
import {
  drapeQuery,
  openDrape,
  openTerrainChooser,
} from './atlas-terrain-helpers';

/** The Global Constraints' World Terrain budgets, logged next to what was measured. */
const BUDGETS = {
  desktop: {
    dataVisibleMs: 2_000,
    longestFrameMs: 200,
    orbitFps: 45,
    rasterP95UpperMs: 2,
    residentBytes: 167_772_160,
    restyleMs: 2_000,
  },
  mobile: {
    dataVisibleMs: 2_000,
    longestFrameMs: 800,
    orbitFps: 45,
    rasterP95UpperMs: 2,
    residentBytes: 100_663_296,
    restyleMs: 2_000,
  },
} as const;

/** How long the report waits for a draped milestone before it records none. */
const MILESTONE_TIMEOUT_MS = 60_000;

/** What the init script records in the page, frame by frame. */
interface DrapeTimes {
  /** `performance.now()` of the first frame with World Terrain on the globe. */
  terrainMs: number | null;
  /** The first frame with the surface draped and a tile delivered. */
  visibleMs: number | null;
}

type ReportWindow = Window & {
  __atlasDrapeTimes: DrapeTimes;
  __atlasLongFrames: number[];
};

type Report = Record<string, unknown>;

/** Waits until the page has recorded a draped milestone; null when it never came. */
async function milestone(
  page: Page,
  key: keyof DrapeTimes,
): Promise<number | null> {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            (k) => (window as never as ReportWindow).__atlasDrapeTimes[k],
            key,
          ),
        { timeout: MILESTONE_TIMEOUT_MS },
      )
      .not.toBeNull();
  } catch {
    return null;
  }
  return page.evaluate(
    (k) => (window as never as ReportWindow).__atlasDrapeTimes[k],
    key,
  );
}

/** Desktop: from the World Terrain choice in the chooser to the draped data. */
async function switchToDraped(page: Page): Promise<Report> {
  await openDrape(page, drapeQuery('oblique', 1, { terrain: 'smooth-globe' }));
  // The chooser opens from the Map controls.
  await page.locator('summary').filter({ hasText: /^Map$/ }).click();
  const chooser = await openTerrainChooser(page);
  // The long frames of the draped session, from the choice on.
  const chosenMs = await page.evaluate(() => {
    (window as never as ReportWindow).__atlasLongFrames.length = 0;
    return performance.now();
  });
  await chooser
    .getByRole('radio', { name: 'Cesium World Terrain terrain' })
    .click();
  const visibleMs = await milestone(page, 'visibleMs');
  return {
    dataVisibleMs: visibleMs === null ? null : visibleMs - chosenMs,
  };
}

/** Mobile: a cold load of `terrain=world-terrain`, from the terrain reaching the globe. */
async function coldLoadDraped(page: Page): Promise<Report> {
  await openDrape(page, drapeQuery('oblique', 1));
  const terrainMs = await milestone(page, 'terrainMs');
  const visibleMs = await milestone(page, 'visibleMs');
  return {
    dataVisibleMs:
      terrainMs === null || visibleMs === null ? null : visibleMs - terrainMs,
  };
}

/**
 * From the palette change to one `atlas-surface` layer again, after the cross-fade showed two,
 * with every tile in view loaded.
 */
async function restyleMs(page: Page): Promise<Report> {
  await expandExplorerSheet(page);
  const summary = page
    .locator('summary')
    .filter({ hasText: /^Inferred surface$/ });
  if (
    !(await summary.evaluate(
      (node) => (node.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
  const done = page.evaluate(
    (timeoutMs) =>
      new Promise<number | null>((resolve) => {
        const started = performance.now();
        let crossFaded = false;
        const sample = () => {
          const probe = window.__atlasTerrainProbe!();
          const surfaces = probe.imageryLayers.filter(
            (name) => name === 'atlas-surface',
          ).length;
          if (surfaces > 1) crossFaded = true;
          const now = performance.now();
          if (crossFaded && surfaces === 1 && probe.tilesLoaded)
            resolve(now - started);
          else if (now - started > timeoutMs) resolve(null);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    MILESTONE_TIMEOUT_MS,
  );
  await page.locator('#atlas-surface-palette').selectOption('viridis');
  const measured = await done;
  // The phone's sheet goes back down, so the scene the pan draws is in view.
  const sheet = page.locator('aside.atlas-controls[data-sheet-state]');
  if ((await sheet.count()) > 0) await setSheetState(sheet, 'peek');
  return { restyleMs: measured };
}

/** Animation frames per second while ArrowLeft is held on the scene for `ms`. */
async function orbitFps(page: Page, ms: number): Promise<Report> {
  await page.locator('.atlas-scene').focus();
  const counted = page.evaluate(
    (durationMs) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const started = performance.now();
        const sample = () => {
          frames += 1;
          const elapsed = performance.now() - started;
          if (elapsed >= durationMs) resolve((frames * 1_000) / elapsed);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    ms,
  );
  // A held key repeats its keydown, about 30 times a second.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(33);
  }
  await page.keyboard.up('ArrowLeft');
  return { orbitFps: await counted };
}

/** The long frames, the raster-time p95, the resident imagery and the renderer. */
async function drapeReport(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const report = window as never as ReportWindow;
    const stats = window.__atlasDrapeStats!();
    const { counts, upperMs } = stats.rasterMs;
    const total = counts.reduce((sum, count) => sum + count, 0);
    let reached = 0;
    let p95: number | null = null;
    for (let bin = 0; bin < counts.length && total > 0; bin++) {
      reached += counts[bin];
      if (reached >= 0.95 * total) {
        p95 = upperMs[bin];
        break;
      }
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      delivered: stats.delivered,
      empty: stats.empty,
      longestFrameMs: Math.max(0, ...report.__atlasLongFrames),
      // JSON has no Infinity: the open last bin is reported by name.
      rasterP95UpperMs:
        p95 !== null && !Number.isFinite(p95) ? 'Infinity' : p95,
      rasterTiles: total,
      renderer:
        gl && debug
          ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
          : 'unknown',
      requested: stats.requested,
      residentBytes: stats.residentBytes,
    };
  });
}

// Report-only until Task 36; runs in both projects.
test('reports the World Terrain draped budgets (report-only until phase 4)', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const mobile = testInfo.project.name === 'mobile-chromium';
  await page.addInitScript(() => {
    window.__atlasSyntheticTerrain = true;
    const report = window as never as ReportWindow;
    const frames: number[] = (report.__atlasLongFrames = []);
    new PerformanceObserver((list) =>
      frames.push(...list.getEntries().map((entry) => entry.duration)),
    ).observe({ type: 'long-animation-frame', buffered: true });
    // The first frames at which World Terrain is on the globe and the data shows draped: an
    // `atlas-surface` layer at α > 0 and a tile delivered. Sampling stops there, so it costs the
    // frames measured after it nothing.
    const times: DrapeTimes = (report.__atlasDrapeTimes = {
      terrainMs: null,
      visibleMs: null,
    });
    const sample = () => {
      const probe = window.__atlasTerrainProbe?.();
      const now = performance.now();
      if (probe?.provider === 'synthetic') times.terrainMs ??= now;
      if (probe?.draped && (window.__atlasDrapeStats?.().delivered ?? 0) > 0)
        times.visibleMs = now;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  if (mobile)
    await (
      await page.context().newCDPSession(page)
    ).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const report = mobile
    ? await coldLoadDraped(page)
    : await switchToDraped(page);
  Object.assign(
    report,
    await restyleMs(page),
    await orbitFps(page, 3_000),
    await drapeReport(page),
  );
  const budgets = BUDGETS[mobile ? 'mobile' : 'desktop'];
  console.log(
    `atlas terrain budgets (${testInfo.project.name}): ${JSON.stringify({ budgets, measured: report })}`,
  );
  await testInfo.attach('terrain-budgets.json', {
    body: JSON.stringify({ budgets, measured: report }, null, 2),
    contentType: 'application/json',
  });
  expect(
    (await page.evaluate(() => window.__atlasDrapeStats!())).delivered,
  ).toBeGreaterThan(0);
});
