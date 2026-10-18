/**
 * The World Terrain budgets of the draped data: one tour per project, measured and asserted
 * (terrain draping design, "Performance budget and measurement" and "Build phases" item 4; Atlas
 * design §11; #483). On a hardware GPU every budget is asserted. On a software renderer (CI's
 * SwiftShader) the timing budgets are skipped, and an annotation says so, while the peak
 * resident Atlas imagery, a count of tiles rather than a timing, is asserted on every renderer:
 * phase 4 decision 4 of the plan, its one departure from the spec, which skips every terrain
 * budget there (pending the owner's sign-off). The phone's peak needed none of the mobile
 * fallbacks.
 *
 * CI has no Cesium ion token, so the e2e build stands its synthetic terrain in for World Terrain
 * (src/atlas/e2e-hooks.ts) and publishes the drape stats as `window.__atlasDrapeStats`. So this
 * spec runs under playwright.config.ts with the e2e build, not under
 * playwright.performance.config.ts, which asserts a production build.
 *
 * The tour, the same in both projects (the phone's page CPU slowed ×4, and it must be a coarse
 * pointer, or it would measure the desktop's policy): HbS over the synthetic peak on the smooth
 * globe, every layer on; World Terrain chosen in the chooser (data visible: the surface's fade has
 * begun, past the one pre-warm frame that draws it unseen); an orbit (frame rate, NaN if the drag
 * left the camera where it was, since an idle page counts frames at its display rate); three
 * zoom-ins; Physical relief 1 → 3, whose ground resampling the long frames include; a palette and
 * then a Honmoon restyle (each to `tilesLoaded`); and Home. An init script samples the resident
 * Atlas imagery every frame for its peak and records the long animation frames.
 *
 * Each step waits for the draped data to settle first. A hardware run must settle. Under a
 * software renderer, whose frames take about a second each in CI, a settle that runs out of time
 * is recorded instead and the tour goes on: the timing budgets are skipped there, and a view whose
 * tiles never all loaded leaves the peak resident imagery only a lower bound, which the tour then
 * reports as NaN: the memory budget fails, naming the settles that ran out, rather than pass on
 * a lower bound.
 *
 * Density: the e2e fixture's grids hold 256 cells, where production's res-4 grid holds 77,844 over
 * almost all land, and only non-empty tiles are resident (`scene/draped/drape-stats.ts`), so the
 * fixture's peak is a lower bound for production. The decision on the mobile fallbacks rests on
 * this tour at production density: the e2e build over the public bucket. What this spec asserts
 * holds at the fixture's density only: the one headed run at production density met both memory
 * budgets but missed three timing budgets (interaction design §5.2). The e2e build carries
 * its hooks only with the fixture catalog's path (#453), so such a run puts
 * `public/data/atlas/catalog.json` in that file for one local build, never committed (both hold
 * HbS `v3/map-2026-08`).
 */

import { expect, test, type Page } from '@playwright/test';

import { SYNTHETIC_PEAK } from '../src/atlas/e2e-hooks';
import { PREWARM_ALPHA } from '../src/atlas/geometry/raster/types';
import {
  expandExplorerSheet,
  setSheetState,
  touchDrag,
  waitForAtlasReady,
  waitForRevealWave,
} from './atlas-mobile-helpers';
import {
  cameraSettled,
  drapeQuery,
  drapeSettled,
  drapeUnsettled,
  openTerrainChooser,
  probe,
} from './atlas-terrain-helpers';
import {
  TERRAIN_BUDGETS,
  isSoftwareRenderer,
  terrainBudgetFailures,
  type TerrainPerformanceMetrics,
  type TerrainProfile,
} from './support/terrain-budgets';

/** How long the tour waits for a draped milestone before it records none (NaN). */
const MILESTONE_TIMEOUT_MS = 60_000;

/**
 * The orbit: 160 px across in 20 steps, counting frames over 1.2 s, as atlas-performance does. A
 * turn of the camera below `minDegrees` (about 1 km) means the drag missed the globe.
 */
const ORBIT = {
  countMs: 1_200,
  dx: 160,
  dy: 40,
  minDegrees: 0.01,
  steps: 20,
} as const;

/**
 * Under a software renderer, how long the tour waits for each settle, and for all of them
 * together, before it records one as missed.
 */
const SOFTWARE_SETTLE = { eachMs: 60_000, totalMs: 300_000 } as const;

/** What the init script keeps in the page. */
type TourWindow = Window & {
  __atlasLongFrames: number[];
  __atlasPeakResident: number;
};

/** The tour's start: HbS over the peak on the smooth globe, 400 km up, looking 45° down. */
const START_QUERY = drapeQuery('oblique', 1, {
  edges: 'true',
  geometry: 'triangles',
  height: '400000',
  lat: String(SYNTHETIC_PEAK.lat),
  layers: 'surface,observations,support,context,countries',
  palette: 'rainbow',
  pitch: '-45',
  terrain: 'smooth-globe',
});

/** Opens a closed controls section (`<details>`) by its summary; an open one stays open. */
async function openSection(page: Page, name: string): Promise<void> {
  await expandExplorerSheet(page);
  const summary = page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${name}$`) });
  const open = await summary.evaluate(
    (node) => (node.parentElement as HTMLDetailsElement).open,
  );
  if (!open) await summary.click();
}

/** The phone's controls sheet goes back down to peek, so the scene is in view; no-op on desktop. */
async function lowerSheet(page: Page): Promise<void> {
  const sheet = page.locator('aside.atlas-controls[data-sheet-state]');
  if ((await sheet.count()) > 0) await setSheetState(sheet, 'peek');
}

/**
 * From the World Terrain choice in the chooser to the first frame with a tile delivered and the
 * surface drawn above `PREWARM_ALPHA`: its fade has begun. The phase 2 report took the first frame
 * with the surface draped, which since the pre-warm is the one frame a new layer draws unseen to
 * compile its shader, before its fade. NaN if that frame never came.
 */
async function switchToWorldTerrain(page: Page): Promise<number> {
  await openSection(page, 'Map');
  const chooser = await openTerrainChooser(page);
  const visible = page.evaluate(
    ({ prewarmAlpha, timeoutMs }) =>
      new Promise<number>((resolve) => {
        const started = performance.now();
        const sample = () => {
          const elapsed = performance.now() - started;
          if (
            (window.__atlasTerrainProbe?.().surfaceAlpha ?? 0) > prewarmAlpha &&
            (window.__atlasDrapeStats?.().delivered ?? 0) > 0
          )
            resolve(elapsed);
          else if (elapsed > timeoutMs) resolve(Number.NaN);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    { prewarmAlpha: PREWARM_ALPHA, timeoutMs: MILESTONE_TIMEOUT_MS },
  );
  await chooser
    .getByRole('radio', { name: 'Cesium World Terrain terrain' })
    .click();
  const dataVisibleMs = await visible;
  await page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();
  return dataVisibleMs;
}

/**
 * Animation frames per second over 1.2 s while the globe is dragged 160 px across: by mouse, or
 * on the phone by one finger, and how far that turned the camera. The rate is NaN if the drag
 * left the camera where it was: then nothing orbited, and an idle page counts frames at its
 * display rate.
 */
async function orbit(
  page: Page,
  profile: TerrainProfile,
): Promise<{ fps: number; turnedDegrees: number }> {
  await lowerSheet(page);
  const before = await probe(page);
  const box = (await page.locator('.atlas-scene canvas').boundingBox())!;
  // On the phone, above the peeking sheet.
  const from = {
    x: box.x + box.width * (profile === 'mobile' ? 0.3 : 0.58),
    y: box.y + box.height * (profile === 'mobile' ? 0.35 : 0.52),
  };
  const to = { x: from.x + ORBIT.dx, y: from.y + ORBIT.dy };
  const counted = page.evaluate(
    (countMs) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const started = performance.now();
        const sample = () => {
          frames += 1;
          const elapsed = performance.now() - started;
          if (elapsed >= countMs) resolve((frames * 1_000) / elapsed);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    ORBIT.countMs,
  );
  if (profile === 'mobile') await touchDrag(page, from, to, ORBIT.steps);
  else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: ORBIT.steps });
    await page.mouse.up();
  }
  const fps = await counted;
  const after = await probe(page);
  const turnedDegrees = Math.hypot(
    after.cameraLon - before.cameraLon,
    after.cameraLat - before.cameraLat,
  );
  return {
    fps: turnedDegrees >= ORBIT.minDegrees ? fps : Number.NaN,
    turnedDegrees,
  };
}

/** Presses one of the camera controls by name. */
async function pressCameraControl(page: Page, name: string): Promise<void> {
  await expandExplorerSheet(page);
  await page.getByRole('button', { exact: true, name }).click();
}

/** Moves 'Physical relief ×' to `relief`, and waits for the globe to stand at it. */
async function setRelief(page: Page, relief: number): Promise<void> {
  await openSection(page, 'Map');
  const chooser = await openTerrainChooser(page);
  await chooser.getByLabel('Physical relief ×').fill(String(relief));
  await expect(page).toHaveURL(new RegExp(`relief=${relief}(&|$)`));
  await page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();
  await expect
    .poll(async () => (await probe(page)).verticalExaggeration)
    .toBe(relief);
}

/**
 * From a surface restyle (`change`) to one `atlas-surface` layer again, after the new one was
 * added beside the old, with every tile in view loaded; NaN if that never came. The probe's
 * `layerStack` lists the incoming layer from its add at alpha 0, so a sample need not land inside
 * the 300 ms cross-fade, which a slow first swap frame can end at once.
 */
async function restyleMs(
  page: Page,
  change: () => Promise<unknown>,
): Promise<number> {
  await openSection(page, 'Inferred surface');
  const done = page.evaluate(
    (timeoutMs) =>
      new Promise<number>((resolve) => {
        const started = performance.now();
        let added = false;
        let retired = false;
        const sample = () => {
          const probe = window.__atlasTerrainProbe!();
          const surfaces = probe.layerStack.filter(
            (name) => name === 'atlas-surface',
          ).length;
          const elapsed = performance.now() - started;
          if (surfaces > 1) added = true;
          if (added && surfaces === 1) retired = true;
          if (retired && probe.tilesLoaded) resolve(elapsed);
          else if (elapsed > timeoutMs) resolve(Number.NaN);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    MILESTONE_TIMEOUT_MS,
  );
  await change();
  return done;
}

/** `UNMASKED_RENDERER_WEBGL`, or 'unknown'. */
async function rendererOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : 'unknown';
  });
}

/**
 * Settles the draped data between the tour's steps: `drapeSettled` on a hardware renderer. On a
 * software renderer, a settle that runs out of time (`SOFTWARE_SETTLE`) is added to `missed`
 * instead, and the tour goes on.
 */
function tourSettler(page: Page, software: boolean) {
  const missed: string[] = [];
  let leftMs: number = SOFTWARE_SETTLE.totalMs;
  return {
    missed,
    async settle(step: string): Promise<void> {
      if (!software) return drapeSettled(page);
      const started = Date.now();
      const held = await drapeUnsettled(
        page,
        Math.min(SOFTWARE_SETTLE.eachMs, leftMs),
      );
      leftMs = Math.max(0, leftMs - (Date.now() - started));
      if (held !== null) missed.push(`${step}: ${held}`);
    },
  };
}

/** The long frames, the raster histogram and the peak resident imagery. */
async function pageMeasures(
  page: Page,
): Promise<
  Pick<
    TerrainPerformanceMetrics,
    'longFramesMs' | 'peakResidentBytes' | 'rasterMs'
  >
> {
  return page.evaluate(() => {
    const tour = window as never as TourWindow;
    const { rasterMs } = window.__atlasDrapeStats!();
    return {
      longFramesMs: [...tour.__atlasLongFrames],
      peakResidentBytes: tour.__atlasPeakResident,
      rasterMs: {
        counts: [...rasterMs.counts],
        upperMs: [...rasterMs.upperMs],
      },
    };
  });
}

/** JSON has no Infinity or NaN: the raster histogram's open last bin, or a missed milestone. */
function reportJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) =>
      typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
    2,
  );
}

test('World Terrain meets its budgets', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const profile: TerrainProfile =
    testInfo.project.name === 'mobile-chromium' ? 'mobile' : 'desktop';
  await page.addInitScript(() => {
    window.__atlasSyntheticTerrain = true;
    const tour = window as never as TourWindow;
    tour.__atlasPeakResident = 0;
    tour.__atlasLongFrames = [];
    new PerformanceObserver((list) =>
      tour.__atlasLongFrames.push(
        ...list.getEntries().map((entry) => entry.duration),
      ),
    ).observe({ type: 'long-animation-frame', buffered: true });
    const sample = () => {
      const stats = window.__atlasDrapeStats?.();
      if (stats)
        tour.__atlasPeakResident = Math.max(
          tour.__atlasPeakResident,
          stats.residentBytes,
        );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  if (profile === 'mobile')
    await (
      await page.context().newCDPSession(page)
    ).send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // 1. The smooth globe, settled; the long frames count from the terrain switch.
  await page.goto(`/app/?${START_QUERY}`);
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    'a phone is a coarse pointer, a desktop is not',
  ).toBe(profile === 'mobile');
  await waitForAtlasReady(page);
  await waitForRevealWave(page);
  await cameraSettled(page);
  const renderer = await rendererOf(page);
  const { missed, settle } = tourSettler(page, isSoftwareRenderer(renderer));
  await page.evaluate(() => {
    (window as never as TourWindow).__atlasLongFrames.length = 0;
  });

  // 2. World Terrain, from the chooser.
  const dataVisibleMs = await switchToWorldTerrain(page);
  await settle('World Terrain');

  // 3. An orbit.
  const orbited = await orbit(page, profile);
  await settle('orbit');

  // 4. Three zoom-ins.
  for (let press = 1; press <= 3; press += 1) {
    await pressCameraControl(page, 'Zoom in');
    await settle(`zoom in ${press}`);
  }

  // 5. Physical relief 1 → 3: the ground heights resample, inside the long frames.
  await setRelief(page, 3);
  await settle('relief 3');

  // 6. A palette restyle, then a geometry restyle to Honmoon.
  const restyles = [
    await restyleMs(page, () =>
      page
        .getByLabel('Surface palette', { exact: true })
        .selectOption('viridis'),
    ),
    await restyleMs(page, () =>
      page.locator('#atlas-surface-geometry').selectOption('honmoon'),
    ),
  ];
  await settle('restyles');

  // 7. Home.
  await pressCameraControl(page, 'Home');
  await settle('Home');

  // 8. What the tour measured; with a settle missed, the peak is only a lower bound.
  const measured = await pageMeasures(page);
  const metrics: TerrainPerformanceMetrics = {
    profile,
    renderer,
    dataVisibleMs,
    restyleMs: restyles,
    orbitFps: orbited.fps,
    longFramesMs: measured.longFramesMs,
    rasterMs: measured.rasterMs,
    peakResidentBytes:
      missed.length === 0 ? measured.peakResidentBytes : Number.NaN,
  };
  const json = reportJson(metrics);
  console.log(`atlas terrain performance (${testInfo.project.name}): ${json}`);
  console.log(
    `atlas terrain budgets (${testInfo.project.name}): ${reportJson({
      budgets: TERRAIN_BUDGETS[profile],
      outside: terrainBudgetFailures(metrics),
      // Software renderers only: the settles that ran out of time, and the peak they leave.
      missedSettles: missed,
      sampledPeakResidentBytes: measured.peakResidentBytes,
      orbitTurnedDegrees: orbited.turnedDegrees,
      // The tiles behind the numbers, as they stand at the end of the tour.
      tiles: await page.evaluate(() => {
        const { delivered, empty, requested, residentBytes } =
          window.__atlasDrapeStats!();
        return { delivered, empty, requested, residentBytes };
      }),
    })}`,
  );
  await testInfo.attach('atlas-terrain-performance.json', {
    body: json,
    contentType: 'application/json',
  });
  expect(
    (await page.evaluate(() => window.__atlasDrapeStats!())).delivered,
    'the draped tiles arrived',
  ).toBeGreaterThan(0);
  if (isSoftwareRenderer(metrics.renderer))
    testInfo.annotations.push({
      type: 'timing budgets skipped',
      description: `software renderer: ${metrics.renderer}`,
    });
  expect(
    terrainBudgetFailures(metrics),
    missed.length === 0
      ? `inside the ${profile} budgets`
      : `inside the ${profile} budgets; settles that ran out of time: ${missed.join('; ')}`,
  ).toEqual([]);
});
