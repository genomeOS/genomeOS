/**
 * Shared Playwright helpers for physical terrain and the data draped onto it (Atlas design §11;
 * terrain draping design, "Test plan"; #483). CI has no Cesium ion token, so the e2e build stands
 * a synthetic terrain in for World Terrain when a test sets `window.__atlasSyntheticTerrain`
 * (src/atlas/e2e-hooks.ts): a cone under Everest, and a 6 km Gaussian peak under the HbS Spain
 * survey, where the e2e grid supports every res-4 cell within 2σ of the apex. The scene reports
 * itself through `window.__atlasTerrainProbe`.
 *
 * These helpers read that probe, open the explorer over the peak at two fixed cameras, find the
 * summit on the page, and tell whether the inferred surface shows there. That last check changes
 * the surface opacity rather than toggling the layer: a toggle also switches the globe's ground
 * atmosphere (terrain draping design, "Per layer under World Terrain"), which changes the summit's
 * pixels even while the terrain buries the surface.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import {
  SYNTHETIC_PEAK,
  type CameraMotion,
  type TerrainProbe,
} from '../src/atlas/e2e-hooks';
import { readE2eCatalog } from './atlas-browser-fixture';
import { waitForAtlasReady, waitForRevealWave } from './atlas-mobile-helpers';

export interface Point {
  x: number;
  y: number;
}

/** Reads `window.__atlasTerrainProbe`, once the synthetic terrain's module has published it. */
export async function probe(page: Page): Promise<TerrainProbe> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__atlasTerrainProbe))
    .toBe('function');
  return page.evaluate(() => window.__atlasTerrainProbe!());
}

/** The camera has finished the explorer's flight to the linked view. */
export async function cameraSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const read = (
            window as Window & { __atlasCameraMotion?: () => CameraMotion }
          ).__atlasCameraMotion;
          return read ? !read().flying && !read().moving : false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Opens the 'Basemap and terrain' dialog and returns it. */
export async function openTerrainChooser(page: Page): Promise<Locator> {
  await page
    .getByRole('button', { name: 'Choose basemap and terrain' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Basemap and terrain' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Two animation frames: the one that renders a change the page has made, and the one after. */
export async function afterNextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export type DrapeView = 'nadir' | 'oblique';

/** 245 km of latitude: the oblique camera stands this far due south of the apex. */
const OBLIQUE_SOUTH_DEGREES = 2.2;

/**
 * The two cameras the drape tests look at `SYNTHETIC_PEAK` from, as the URL's camera parameters.
 * Nadir stands 60 km above the apex, looking straight down. Oblique stands 245 km south at
 * 100 km, looking north 20° below the horizon, so the summit lies near the view axis: at relief 3
 * the ray through it reaches the ellipsoid about 50 km further on, in `84392b5ffffffff`, not in the
 * summit's own `84390cbffffffff`.
 */
export const DRAPE_CAMERAS: Record<
  DrapeView,
  { heading: 0; height: number; lat: number; lon: number; pitch: number }
> = {
  nadir: {
    heading: 0,
    height: 60_000,
    lat: SYNTHETIC_PEAK.lat,
    lon: SYNTHETIC_PEAK.lon,
    pitch: -90,
  },
  oblique: {
    heading: 0,
    height: 100_000,
    lat: SYNTHETIC_PEAK.lat - OBLIQUE_SOUTH_DEGREES,
    lon: SYNTHETIC_PEAK.lon,
    pitch: -20,
  },
};

const HBS = readE2eCatalog().artifacts.find(({ id }) => id === 'hbs-rs334')!;
/**
 * The e2e fixture's HbS version, as the URL names it (`model_version/data_version`). A version
 * the catalog does not hold is corrected, and the correction's notice banner would lie over the
 * scene.
 */
const HBS_VERSION = `${HBS.model_version}/${HBS.data_version}`;

/**
 * The explorer's query for HbS over the peak under World Terrain at `relief`, seen from `view`.
 * Day/night is off, and so are cell edges unless a test turns them on, so a probe lists only the
 * layers it expects; `extra` overrides any key.
 */
export function drapeQuery(
  view: DrapeView,
  relief: number,
  extra: Record<string, string> = {},
): string {
  const camera = DRAPE_CAMERAS[view];
  return new URLSearchParams({
    entity: 'hbs-rs334',
    version: HBS_VERSION,
    metric: 'post_mean',
    terrain: 'world-terrain',
    relief: String(relief),
    dayNight: 'false',
    edges: 'false',
    layers: 'surface,support',
    heading: String(camera.heading),
    height: String(camera.height),
    lat: String(camera.lat),
    lon: String(camera.lon),
    pitch: String(camera.pitch),
    ...extra,
  }).toString();
}

/**
 * Opens the explorer at `query` and waits for the map to be ready, the reveal wave to pass, the
 * camera to settle and the synthetic terrain to reach the globe. The test sets
 * `window.__atlasSyntheticTerrain` first, in an init script.
 */
export async function openDrape(page: Page, query: string): Promise<void> {
  await page.goto(`/app/?${query}`);
  await waitForAtlasReady(page);
  await waitForRevealWave(page);
  await cameraSettled(page);
  await expect
    .poll(async () => (await probe(page)).provider, { timeout: 30_000 })
    .toBe('synthetic');
}

/**
 * Where `SYNTHETIC_PEAK`'s summit stands on the rendered (exaggerated) ground, in page CSS px,
 * once every tile in view has loaded.
 */
export async function apexOnPage(page: Page): Promise<Point> {
  const found: { apex: Point | null } = { apex: null };
  await expect
    .poll(
      async () => {
        const { apexWindow, tilesLoaded } = await probe(page);
        found.apex = tilesLoaded ? apexWindow : null;
        return found.apex !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const canvas = await page.evaluate(() => {
    const { left, top } = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    return { left, top };
  });
  return { x: canvas.left + found.apex!.x, y: canvas.top + found.apex!.y };
}

/** The side of the square of page pixels sampled around the summit, in CSS px. */
export const SUMMIT_PATCH_PX = 7;

/** A square screenshot of the page, `sizePx` CSS px wide, centred on `at`, as a base64 PNG. */
export async function summitPatch(
  page: Page,
  at: Point,
  sizePx = SUMMIT_PATCH_PX,
): Promise<string> {
  const png = await page.screenshot({
    clip: {
      height: sizePx,
      width: sizePx,
      x: Math.round(at.x - sizePx / 2),
      y: Math.round(at.y - sizePx / 2),
    },
    scale: 'css',
  });
  return png.toString('base64');
}

/** A pixel has changed when any of its channels differs by more than this (0 to 255). */
export const CHANGED_CHANNEL = 16;

/**
 * The share of pixels that differ between two patches of one size, decoded in the page: a pixel
 * counts when any channel differs by more than `CHANGED_CHANNEL`.
 */
export async function changedShare(
  page: Page,
  before: string,
  after: string,
): Promise<number> {
  return page.evaluate(
    async ({ after, before, threshold }) => {
      const pixels = async (base64: string): Promise<ImageData> => {
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: 'image/png' }),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [from, to] = await Promise.all([pixels(before), pixels(after)]);
      if (from.width !== to.width || from.height !== to.height)
        throw new Error(
          `patches differ in size: ${from.width}×${from.height} and ${to.width}×${to.height}`,
        );
      let changed = 0;
      for (let offset = 0; offset < from.data.length; offset += 4) {
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(
            from.data[offset + channel] - to.data[offset + channel],
          );
          if (delta > threshold) {
            changed++;
            break;
          }
        }
      }
      return changed / (from.width * from.height);
    },
    { after, before, threshold: CHANGED_CHANNEL },
  );
}

/**
 * Sets the surface opacity through its slider, opening the 'Inferred surface' controls if they
 * are closed, and waits until the URL carries the new value and the next frame is painted.
 */
export async function setSurfaceOpacity(
  page: Page,
  opacity: number,
): Promise<void> {
  const summary = page
    .locator('summary')
    .filter({ hasText: /^Inferred surface$/ });
  const open = await summary.evaluate(
    (node) => (node.parentElement as HTMLDetailsElement).open,
  );
  if (!open) await summary.click();
  await page.getByLabel(/Surface opacity/).fill(String(opacity));
  await expect
    .poll(() => new URL(page.url()).searchParams.get('opacity'))
    .toBe(String(opacity));
  await afterNextPaint(page);
}

/** How much of the summit patch must change between opacity 0.2 and 1 for the surface to show. */
const VISIBLE_SHARE = 0.8;

/**
 * Whether the inferred surface shows at the summit: its patch at surface opacity 0.2 and at 1
 * differ in at least 80% of their pixels. A surface the terrain buries leaves the patch alone.
 */
export async function surfaceVisibleAtApex(page: Page): Promise<boolean> {
  const at = await apexOnPage(page);
  await setSurfaceOpacity(page, 0.2);
  const faint = await summitPatch(page, at);
  await setSurfaceOpacity(page, 1);
  const full = await summitPatch(page, at);
  return (await changedShare(page, faint, full)) >= VISIBLE_SHARE;
}
