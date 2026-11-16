/** Browser-test helpers for the surface reveal wave (#453; fast-load design §B.6.7, amended
 * 2026-10-13 and 2026-10-14): hold the wave at a progress, and read what a held frame shows.
 *
 * The e2e build alone honours the hold and reports the camera's motion (`src/atlas/e2e-hooks.ts`).
 * Frames are page screenshots compared in the browser (no PNG dependency in Node), pixel by pixel
 * against a frame taken before any surface showed.
 */

import { expect, type Page } from '@playwright/test';

import type { CameraMotion } from '../src/atlas/e2e-hooks';
import { globeViewCentre } from './atlas-globe-helpers';

declare global {
  interface Window {
    __atlasRevealWaveHold?: number | null;
    __atlasCameraMotion?: () => CameraMotion;
  }
}

/**
 * Surface only, so no markers, sampling areas, masks, imagery, borders or outlines change pixels
 * between frames.
 * The cold reveal runs at the home view (the explorer flies to a linked camera only after it),
 * whose centre (12° N, 20° E) has the e2e fixture's nearest supported cell 3.9° away, in both
 * HbS and G6PD, and 27 and 28 of them 38–62° away, towards the limb.
 */
export const SURFACE_ONLY = new URLSearchParams({
  edges: 'false',
  layers: 'surface',
  samplingAreas: 'false',
}).toString();

/** The default home camera's height (scene-policy.ts HOME_CAMERA). */
export const HOME_HEIGHT_METRES = 16_500_000;

/**
 * A linked camera straight above 8442313ffffffff, supported in both HbS and G6PD, so a wave that
 * starts there (a dataset switch, once the camera has flown in) has a cell at the view centre.
 */
export function cellCamera(height: number, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    edges: 'false',
    heading: '0',
    height: String(height),
    lat: '26.32003897616907',
    layers: 'surface',
    lon: '61.28961944715503',
    pitch: '-90',
    samplingAreas: 'false',
    ...extra,
  }).toString();
}

/**
 * Early in the wave: the ring's leading edge is a third of the way to the limb on screen (it is
 * timed on screen, `waveFront`), so the cell nearest the centre is grown and nothing half way out
 * has begun.
 */
export const EARLY_PROGRESS = 0.25;

/** Holds every wave of the page from its first frame at `progress` (set before navigation). */
export async function holdRevealWaveFromStart(
  page: Page,
  progress: number,
): Promise<void> {
  await page.addInitScript((value) => {
    window.__atlasRevealWaveHold = value;
  }, progress);
}

/** Three animation frames, so the scene's render loop has drawn the latest wave state. */
export async function renderedFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
}

/** Stands the wave at `progress` (0 to 1), or lets it run with null, and waits for it to draw. */
export async function holdRevealWave(
  page: Page,
  progress: number | null,
): Promise<void> {
  await page.evaluate((value) => {
    window.__atlasRevealWaveHold = value;
  }, progress);
  await renderedFrames(page);
}

/** One frame of the page, as base64 PNG, with CSS animations settled. */
export async function waveFrame(page: Page): Promise<string> {
  return (await page.screenshot({ animations: 'disabled' })).toString('base64');
}

/**
 * Any camera flight has ended: no flight the scene started is under way, and no drawn frame has
 * moved the camera for half a second (`window.__atlasCameraMotion`, e2e build only). It reads the
 * camera, not the canvas, so it waits for nothing else still loading, and each read is one quick
 * call. A screenshot waits for several frames, and under CI's software WebGL the page drew a
 * frame only every 1–1.5 s here, so not one pair of screenshots fit in a 5 s poll.
 */
export async function cameraAtRest(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const read = window.__atlasCameraMotion;
        if (!read) throw new Error('The e2e build publishes no camera motion.');
        return read();
      }),
    )
    .toEqual({ flying: false, moving: false });
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The view centre, the radius (CSS px) of the "at the centre" region around it, and the distance
 * beyond which a pixel counts as far from it ("near the limb").
 */
export interface WaveView {
  centre: Point;
  near: number;
  farFrom: number;
}

/**
 * The home view: where the camera's view ray meets the globe, drawn at the canvas centre on a
 * phone and in the open area beside the controls panel on desktop (#452); a region around it
 * wide enough for the fixture cell 3.9° away (about a tenth of the globe's radius); and a limb
 * bound at 55% of the globe's on-screen radius seen from `height` m (Cesium's 60° field of view
 * spans the canvas's longer side, and the desktop offset shifts the projection, not its scale).
 */
export async function globeView(
  page: Page,
  height = HOME_HEIGHT_METRES,
): Promise<WaveView> {
  const box = await page.locator('.atlas-scene canvas').first().boundingBox();
  if (!box) throw new Error('The Atlas canvas is not laid out.');
  const earth = 6_371_000;
  const half = Math.max(box.width, box.height) / 2;
  const radius =
    (half * Math.tan(Math.asin(earth / (earth + height)))) /
    Math.tan(Math.PI / 6);
  return {
    centre: await globeViewCentre(page),
    farFrom: 0.55 * radius,
    near: 0.1 * radius,
  };
}

export interface WaveReading {
  /** Bare-canvas pixels within `near` of the view centre coloured in the early frame. */
  centreEarly: number;
  /** The same, once the wave is done. */
  centreDone: number;
  /** Bare-canvas pixels far from the centre (`farFrom`) coloured once the wave is done. */
  far: number;
  /** Of those, the ones already coloured in the early frame. */
  farEarly: number;
  /** A far pixel coloured once done, inside its cell (its 3 × 3 CSS neighbours are too). */
  farPoint: Point | null;
}

/**
 * Reads three frames of one view: `before` shows no surface, `early` is held early in the wave
 * and `done` follows its end. A pixel is coloured when some channel differs from `before` by
 * more than 16; only pixels where the canvas is the topmost element count.
 */
export async function readWave(
  page: Page,
  frames: { before: string; early: string; done: string },
  view: WaveView,
): Promise<WaveReading> {
  return page.evaluate(
    async ({ frames, view }) => {
      const decode = async (base64: string) => {
        const blob = await (
          await fetch(`data:image/png;base64,${base64}`)
        ).blob();
        const bitmap = await createImageBitmap(blob, {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D context for PNG decoding.');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [before, early, done] = await Promise.all([
        decode(frames.before),
        decode(frames.early),
        decode(frames.done),
      ]);
      const { width, height } = before;
      const scale = width / window.innerWidth;
      const differs = (frame: ImageData, index: number) => {
        for (let channel = 0; channel < 3; channel += 1)
          if (
            Math.abs(
              frame.data[index + channel] - before.data[index + channel],
            ) > 16
          )
            return true;
        return false;
      };
      const onCanvas = new Map<string, boolean>();
      const bare = (x: number, y: number) => {
        const key = `${Math.floor(x)},${Math.floor(y)}`;
        let hit = onCanvas.get(key);
        if (hit === undefined) {
          hit =
            document
              .elementFromPoint(Math.floor(x) + 0.5, Math.floor(y) + 0.5)
              ?.matches('.atlas-scene canvas') ?? false;
          onCanvas.set(key, hit);
        }
        return hit;
      };
      const coloured = (frame: ImageData, x: number, y: number) => {
        const px = Math.floor(x * scale);
        const py = Math.floor(y * scale);
        if (px < 0 || py < 0 || px >= width || py >= height) return false;
        return differs(frame, (py * width + px) * 4);
      };
      const reading = {
        centreDone: 0,
        centreEarly: 0,
        far: 0,
        farEarly: 0,
        farPoint: null as { x: number; y: number } | null,
      };
      for (let py = 0; py < height; py += 1)
        for (let px = 0; px < width; px += 1) {
          const index = (py * width + px) * 4;
          const x = px / scale;
          const y = py / scale;
          const distance = Math.hypot(x - view.centre.x, y - view.centre.y);
          if (distance <= view.near) {
            if (!bare(x, y)) continue;
            if (differs(early, index)) reading.centreEarly += 1;
            if (differs(done, index)) reading.centreDone += 1;
          } else if (distance >= view.farFrom && differs(done, index)) {
            if (!bare(x, y)) continue;
            reading.far += 1;
            if (differs(early, index)) reading.farEarly += 1;
            const inside = [-1, 0, 1].every((dx) =>
              [-1, 0, 1].every(
                (dy) => coloured(done, x + dx, y + dy) && bare(x + dx, y + dy),
              ),
            );
            if (inside && reading.farPoint === null)
              reading.farPoint = {
                x: Math.floor(x) + 0.5,
                y: Math.floor(y) + 0.5,
              };
          }
        }
      return reading;
    },
    { frames, view },
  );
}
