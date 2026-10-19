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
 * The tour, the same in both projects (the phone must be a coarse pointer, or it would measure
 * the desktop's policy): HbS over the synthetic peak on the smooth globe, every layer on; World
 * Terrain chosen in the chooser (data visible: the surface's fade has begun, past the one pre-warm
 * frame that draws it unseen); an orbit (frame rate, NaN if the drag left the camera where it
 * was, since an idle page counts frames at its display rate); three zoom-ins; Physical relief
 * 1 → 3, whose ground resampling the long frames include; a palette and then a Honmoon restyle
 * (each to `tilesLoaded` on a hardware GPU; on a software renderer, whose timings are skipped, to
 * the outgoing layer's retirement, which proves the swap happened); and Home. An init script
 * samples the resident Atlas imagery every frame for its peak and records the long animation
 * frames.
 *
 * Attribution, reported and never judged (`support/terrain-tour-attribution.ts`): the tour reads
 * the page's clock at each step's start (World Terrain, the orbit, each zoom-in, relief 3, each
 * restyle, Home), from before it opens the step's controls. The milestones bound steps of their
 * own, read by the page in the frames it measures them in: from the World Terrain click (the
 * data-visible clock's start, just before the click) to data visible, then on from data visible;
 * from each restyle's change to its swap (`tilesLoaded` on a hardware GPU), then on from there.
 * So the step from the click to data visible is as long as `dataVisibleMs`, and holds the ground
 * passes between the two. The init script keeps each long animation frame's start, duration and
 * scripts, and the e2e build's performance measures: `atlas-ground-pass`, one per pass that reads
 * the ground under the draped observations or the grounded highlight ring (its kind, the points
 * it picked, 0 if none; its duration is the pass's ms), and `atlas-draped-ready`, one per draped
 * layer read ready (the layer, the rule that fired, `tilesLoaded` or the 3 s cap, whether the cap
 * had run out by then, and the ms since its add or show). So each long frame lands in the step its
 * longest script began in, with the ground-pass time inside it: its scripts alone would not name
 * the pass, which runs inside Cesium's render callback. Each step sums its ground passes in all
 * and per kind; its readiness entries carry the layer's add on the page's clock, so the step from
 * the click to data visible splits into the time before the add, the readiness wait and the
 * fade's start. The drape stats' running counts at each step's bounds give the tiles each step
 * delivered: the raster time of levels 0–2, which the budget's histogram leaves out, and the
 * request-to-delivery time per level. The console prints each step's longest frames and its sums;
 * the JSON attachment, kept in the test's output directory, also holds every frame, script and
 * ground pass.
 *
 * The phone's profile slows only the page's CPU, ×4, as the spec's "mobile ×4" long-frame budget
 * reads. The data worker that rasterises the draped tiles runs at full speed, so the phone's
 * data-visible and raster numbers are optimistic for a real phone.
 *
 * After each step the tour waits for the draped data to settle (`drapeUnsettled`, which first
 * lets the step's own frame draw). A hardware run must settle. Under a software renderer, whose
 * frames take about a second each in CI and whose tiles there load about nine times slower than
 * under a local SwiftShader, a settle that runs out of time (`SOFTWARE_SETTLE`) is recorded
 * instead and the tour goes on: the timing budgets are skipped there, and a view whose tiles
 * never all loaded leaves the peak resident imagery only a lower bound, which the tour then
 * reports as NaN: the memory budget fails, naming the settles that ran out, rather than pass on
 * a lower bound. A milestone that never came (data visible, or a restyle's swap) fails as not
 * measured on every renderer.
 *
 * Density: the e2e fixture's grids hold 256 cells, where production's res-4 grid holds 77,844 over
 * almost all land, and only non-empty tiles are resident (`scene/draped/drape-stats.ts`), so the
 * fixture's peak is a lower bound for production. The decision on the mobile fallbacks rests on
 * this tour at production density: the e2e build over the public bucket. What this spec asserts
 * holds at the fixture's density only: the one headed run at production density met both memory
 * budgets but missed three timing budgets (interaction design §5.2). To repeat that run, by hand
 * and never in CI: `PUBLIC_ATLAS_DATA_BASE_URL=<the bucket base> bash
 * scripts/terrain-tour-production-density.sh [--project=…] [--headed]`. The e2e build carries its
 * hooks only with the fixture catalog's path (#453), so the script puts
 * `public/data/atlas/catalog.json` in that file for the build alone and restores it on every exit
 * (both hold HbS `v3/map-2026-08`), then runs this tour.
 */

import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import {
  DRAPED_READY_MEASURE,
  GROUND_PASS_MEASURE,
  SYNTHETIC_PEAK,
  type DrapedReadyDetail,
  type GroundPassDetail,
} from '../src/atlas/e2e-hooks';
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
import {
  attributeTour,
  longestScript,
  milestoneSteps,
  type StepAttribution,
  type TourLongFrame,
  type TourMark,
  type TourMeasure,
  type TourRecord,
  type TourStep,
} from './support/terrain-tour-attribution';

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
 * Under a software renderer, how long the tour waits for each settle, and for all nine together,
 * before it records one as missed. CI's SwiftShader took 48 s from a restyle to `tilesLoaded` in
 * phase 3's tour, where a local SwiftShader took 5.4 s; this tour's restyles take up to 12 s to
 * `tilesLoaded` under a local SwiftShader.
 */
const SOFTWARE_SETTLE = { eachMs: 150_000, totalMs: 720_000 } as const;

/** The whole tour, its settles included, on any renderer. */
const TOUR_TIMEOUT_MS = 1_200_000;

/** What the init script keeps in the page. */
type TourWindow = Window & {
  __atlasLongFrames: TourLongFrame[];
  __atlasPeakResident: number;
  __atlasGroundPasses: TourMeasure<GroundPassDetail>[];
  __atlasReadiness: TourMeasure<DrapedReadyDetail>[];
  /** The page's clock (`at`, or now) and the drape stats' running tile counts as they stand. */
  __atlasTourMark: (at?: number) => TourMark;
};

/** How many of a step's longest frames the console report lists; the attachment has them all. */
const REPORTED_FRAMES = 5;

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
 * compile its shader, before its fade. NaN if that frame never came. Both ends are marks on the
 * page's clock: `click`, read as the clock starts just before the click, and `visible`, read in
 * the frame that saw the data (null if it never came).
 */
async function switchToWorldTerrain(page: Page): Promise<{
  dataVisibleMs: number;
  click: TourMark;
  visible: TourMark | null;
}> {
  await openSection(page, 'Map');
  const chooser = await openTerrainChooser(page);
  const visible = page.evaluate(
    ({ prewarmAlpha, timeoutMs }) =>
      new Promise<{ click: TourMark; visible: TourMark | null }>((resolve) => {
        const tour = window as never as TourWindow;
        const click = tour.__atlasTourMark();
        const sample = () => {
          const now = performance.now();
          if (
            (window.__atlasTerrainProbe?.().surfaceAlpha ?? 0) > prewarmAlpha &&
            (window.__atlasDrapeStats?.().delivered ?? 0) > 0
          )
            resolve({ click, visible: tour.__atlasTourMark(now) });
          else if (now - click.startMs > timeoutMs)
            resolve({ click, visible: null });
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    { prewarmAlpha: PREWARM_ALPHA, timeoutMs: MILESTONE_TIMEOUT_MS },
  );
  await chooser
    .getByRole('radio', { name: 'Cesium World Terrain terrain' })
    .click();
  const marks = await visible;
  await page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();
  return {
    ...marks,
    dataVisibleMs: marks.visible
      ? marks.visible.startMs - marks.click.startMs
      : Number.NaN,
  };
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
 * added beside the old, and with `untilTilesLoaded` every tile in view loaded; NaN if that never
 * came. The probe's `layerStack` lists the incoming layer from its add at alpha 0, so a sample
 * need not land inside the 300 ms cross-fade, which a slow first swap frame can end at once. Both
 * ends are marks on the page's clock: `change`, read as the clock starts just before the change,
 * and `done`, read in the frame that saw the swap (null if it never came).
 */
async function restyle(
  page: Page,
  change: () => Promise<unknown>,
  untilTilesLoaded: boolean,
): Promise<{ ms: number; change: TourMark; done: TourMark | null }> {
  await openSection(page, 'Inferred surface');
  const done = page.evaluate(
    ({ timeoutMs, untilTilesLoaded }) =>
      new Promise<{ change: TourMark; done: TourMark | null }>((resolve) => {
        const tour = window as never as TourWindow;
        const changed = tour.__atlasTourMark();
        let added = false;
        let retired = false;
        const sample = () => {
          const probe = window.__atlasTerrainProbe!();
          const surfaces = probe.layerStack.filter(
            (name) => name === 'atlas-surface',
          ).length;
          const now = performance.now();
          if (surfaces > 1) added = true;
          if (added && surfaces === 1) retired = true;
          if (retired && (!untilTilesLoaded || probe.tilesLoaded))
            resolve({ change: changed, done: tour.__atlasTourMark(now) });
          else if (now - changed.startMs > timeoutMs)
            resolve({ change: changed, done: null });
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    { timeoutMs: MILESTONE_TIMEOUT_MS, untilTilesLoaded },
  );
  await change();
  const marks = await done;
  return {
    ...marks,
    ms: marks.done ? marks.done.startMs - marks.change.startMs : Number.NaN,
  };
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

/**
 * The page's clock and the drape stats' running tile counts, read at a step's start; null counts
 * before the draped runtime has published its stats.
 */
async function stepMark(page: Page): Promise<TourMark> {
  return page.evaluate(() => (window as never as TourWindow).__atlasTourMark());
}

/**
 * The raster histogram and the peak resident imagery for the budgets, and for the attribution
 * every long frame, ground pass and readiness the page recorded, the drape stats' running tile
 * counts with their bins, and the page's clock, all in one read: the clock is the tour's end, and
 * every entry the page holds started before it.
 */
async function pageMeasures(page: Page): Promise<{
  budgeted: Pick<TerrainPerformanceMetrics, 'peakResidentBytes' | 'rasterMs'>;
  record: Omit<TourRecord, 'steps'>;
  /** The upper bounds (ms) of the coarse raster and the delivery bins the tile counts are in. */
  bins: { coarseRasterMs: number[]; deliveryMs: number[] };
}> {
  return page.evaluate(() => {
    const tour = window as never as TourWindow;
    const { coarseRasterMs, deliveryMs, rasterMs } =
      window.__atlasDrapeStats!();
    return {
      bins: {
        coarseRasterMs: [...coarseRasterMs.upperMs],
        deliveryMs: [...deliveryMs.upperMs],
      },
      budgeted: {
        peakResidentBytes: tour.__atlasPeakResident,
        rasterMs: {
          counts: [...rasterMs.counts],
          upperMs: [...rasterMs.upperMs],
        },
      },
      record: {
        endMs: performance.now(),
        endTiles: {
          coarseRasterCounts: coarseRasterMs.counts,
          deliveryByLevel: deliveryMs.byLevel,
        },
        groundPasses: [...tour.__atlasGroundPasses],
        longFrames: [...tour.__atlasLongFrames],
        readiness: [...tour.__atlasReadiness],
      },
    };
  });
}

/**
 * Each step for the console: its longest frames (`REPORTED_FRAMES`) with their ground-pass time
 * and longest script, its ground passes in sum and per kind, readiness and the tiles it delivered,
 * only the levels it delivered any at. The attachment carries every frame, script and pass.
 */
function attributionSummary(steps: StepAttribution[]) {
  return steps.map((step) => ({
    step: step.step,
    startMs: step.startMs,
    ms: step.ms,
    longFrames: step.longFrames.length,
    longest: [...step.longFrames]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, REPORTED_FRAMES)
      .map((frame) => {
        const script = longestScript(frame);
        return {
          startMs: frame.startMs,
          ms: frame.ms,
          groundPassMs: frame.groundPassMs,
          longestScript: script
            ? `${script.invoker} ${script.sourceFunctionName} ${Math.round(script.duration)} ms`
            : null,
        };
      }),
    groundPasses: (({ passes: _passes, ...sums }) => sums)(step.groundPasses),
    readiness: step.readiness,
    tiles: step.tiles && {
      coarseRasterCounts: step.tiles.coarseRasterCounts,
      deliveryByLevel: Object.fromEntries(
        step.tiles.deliveryByLevel
          .map((bins, level) => [level, bins] as const)
          .filter(([, bins]) => bins.some((count) => count > 0)),
      ),
    },
  }));
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
  test.setTimeout(TOUR_TIMEOUT_MS);
  const profile: TerrainProfile =
    testInfo.project.name === 'mobile-chromium' ? 'mobile' : 'desktop';
  await page.addInitScript(
    ({ drapedReady, groundPass }) => {
      window.__atlasSyntheticTerrain = true;
      const tour = window as never as TourWindow;
      tour.__atlasPeakResident = 0;
      tour.__atlasLongFrames = [];
      tour.__atlasGroundPasses = [];
      tour.__atlasReadiness = [];
      tour.__atlasTourMark = (at = performance.now()) => {
        const stats = window.__atlasDrapeStats?.();
        return {
          startMs: at,
          tiles: stats
            ? {
                coarseRasterCounts: stats.coarseRasterMs.counts,
                deliveryByLevel: stats.deliveryMs.byLevel,
              }
            : null,
        };
      };
      // A long animation frame and its scripts, as TourLongFrame keeps them; the DOM lib in
      // use declares neither PerformanceLongAnimationFrameTiming nor PerformanceScriptTiming.
      new PerformanceObserver((list) =>
        tour.__atlasLongFrames.push(
          ...list.getEntries().map((entry) => {
            const frame = entry as unknown as TourLongFrame;
            return {
              blockingDuration: frame.blockingDuration,
              duration: frame.duration,
              scripts: frame.scripts.map((script) => ({
                duration: script.duration,
                forcedStyleAndLayoutDuration:
                  script.forcedStyleAndLayoutDuration,
                invoker: script.invoker,
                invokerType: script.invokerType,
                sourceCharPosition: script.sourceCharPosition,
                sourceFunctionName: script.sourceFunctionName,
                sourceURL: script.sourceURL,
                startTime: script.startTime,
              })),
              startTime: frame.startTime,
            };
          }),
        ),
      ).observe({ type: 'long-animation-frame', buffered: true });
      // The e2e build's ground-pass and readiness measures (src/atlas/e2e-hooks.ts).
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const { detail, duration, name, startTime } =
            entry as PerformanceMeasure;
          if (name === groundPass)
            tour.__atlasGroundPasses.push({ detail, duration, startTime });
          else if (name === drapedReady)
            tour.__atlasReadiness.push({ detail, duration, startTime });
        }
      }).observe({ type: 'measure', buffered: true });
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
    },
    { drapedReady: DRAPED_READY_MEASURE, groundPass: GROUND_PASS_MEASURE },
  );
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
  const software = isSoftwareRenderer(renderer);
  const { missed, settle } = tourSettler(page, software);
  await page.evaluate(() => {
    const tour = window as never as TourWindow;
    tour.__atlasLongFrames.length = 0;
    tour.__atlasGroundPasses.length = 0;
    tour.__atlasReadiness.length = 0;
  });
  // Each step's start on the page's clock, so every long frame, ground pass and readiness can be
  // put in the step it began in.
  const steps: TourStep[] = [];
  const beginStep = async (step: string) =>
    steps.push({ step, ...(await stepMark(page)) });

  // 2. World Terrain, from the chooser: its opening, the click to data visible, and on.
  await beginStep('World Terrain');
  const { click, dataVisibleMs, visible } = await switchToWorldTerrain(page);
  steps.push(
    ...milestoneSteps('World Terrain', 'click', 'data visible', click, visible),
  );
  await settle('World Terrain');

  // 3. An orbit.
  await beginStep('orbit');
  const orbited = await orbit(page, profile);
  await settle('orbit');

  // 4. Three zoom-ins.
  for (let press = 1; press <= 3; press += 1) {
    await beginStep(`zoom in ${press}`);
    await pressCameraControl(page, 'Zoom in');
    await settle(`zoom in ${press}`);
  }

  // 5. Physical relief 1 → 3: the ground heights resample, inside the long frames.
  await beginStep('relief 3');
  await setRelief(page, 3);
  await settle('relief 3');

  // 6. A palette restyle, then a geometry restyle to Honmoon: each from its section's opening, the
  // change to its swap (`tilesLoaded` on a hardware GPU), and on.
  const restyles: number[] = [];
  for (const [step, change] of [
    [
      'palette restyle',
      () =>
        page
          .getByLabel('Surface palette', { exact: true })
          .selectOption('viridis'),
    ],
    [
      'Honmoon restyle',
      () => page.locator('#atlas-surface-geometry').selectOption('honmoon'),
    ],
  ] as const) {
    await beginStep(step);
    const restyled = await restyle(page, change, !software);
    restyles.push(restyled.ms);
    steps.push(
      ...milestoneSteps(
        step,
        'change',
        software ? 'swap' : 'tiles loaded',
        restyled.change,
        restyled.done,
      ),
    );
    await settle(step);
  }

  // 7. Home.
  await beginStep('Home');
  await pressCameraControl(page, 'Home');
  await settle('Home');

  // 8. What the tour measured; with a settle missed, the peak is only a lower bound.
  const { bins, budgeted, record } = await pageMeasures(page);
  const metrics: TerrainPerformanceMetrics = {
    profile,
    renderer,
    dataVisibleMs,
    restyleMs: restyles,
    orbitFps: orbited.fps,
    longFramesMs: record.longFrames.map((frame) => frame.duration),
    rasterMs: budgeted.rasterMs,
    peakResidentBytes:
      missed.length === 0 ? budgeted.peakResidentBytes : Number.NaN,
  };
  console.log(
    `atlas terrain performance (${testInfo.project.name}): ${reportJson(metrics)}`,
  );
  console.log(
    `atlas terrain budgets (${testInfo.project.name}): ${reportJson({
      budgets: TERRAIN_BUDGETS[profile],
      outside: terrainBudgetFailures(metrics),
      // Software renderers only: the settles that ran out of time, and the peak they leave.
      missedSettles: missed,
      sampledPeakResidentBytes: budgeted.peakResidentBytes,
      orbitTurnedDegrees: orbited.turnedDegrees,
      // The tiles behind the numbers, as they stand at the end of the tour.
      tiles: await page.evaluate(() => {
        const { delivered, empty, requested, residentBytes } =
          window.__atlasDrapeStats!();
        return { delivered, empty, requested, residentBytes };
      }),
    })}`,
  );
  // Where the time went, step by step: reported, not judged.
  const attribution = attributeTour({ ...record, steps });
  console.log(
    `atlas terrain attribution (${testInfo.project.name}): ${reportJson({
      bins,
      steps: attributionSummary(attribution),
    })}`,
  );
  // A file in the test's output directory, which outlives the run whatever the reporter.
  const report = testInfo.outputPath('atlas-terrain-performance.json');
  writeFileSync(
    report,
    reportJson({ ...metrics, attribution: { bins, steps: attribution } }),
  );
  await testInfo.attach('atlas-terrain-performance.json', {
    contentType: 'application/json',
    path: report,
  });
  expect(
    (await page.evaluate(() => window.__atlasDrapeStats!())).delivered,
    'the draped tiles arrived',
  ).toBeGreaterThan(0);
  if (software)
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
