/**
 * Playwright helpers for where the Atlas draws its globe (fast-load design §A.1.13, amended
 * 2026-10-13; #452). On desktop the camera's view axis is drawn half the width the controls panel
 * covers to the right of the canvas centre; on a phone, or with the panel hidden, at the centre.
 * Also the fixture readouts by which the picking tests tell which cell a hover found.
 */

import type { Page } from '@playwright/test';
import { splitLongToH3Index } from 'h3-js';

import { atlasCatalogSchema } from '../src/atlas/contracts';
import { decodeGrid, decodeRender } from '../src/atlas/gosa/decode';
import { percent } from '../src/components/atlas/surface-cell-view';
import { readE2eCatalog, readE2eObject } from './atlas-browser-fixture';

export interface Point {
  x: number;
  y: number;
}

/**
 * An unlit globe with a magenta ocean and nothing on it but country borders, so its disc can be
 * found in a screenshot. The default camera shows the whole globe.
 */
export const GLOBE_DISC_QUERY = new URLSearchParams({
  dayNight: 'false',
  layers: 'countries',
  oceanColor: '#ff00ff',
}).toString();

/**
 * Where the camera's view axis should be drawn, in CSS px, worked out from the page layout alone:
 * the canvas centre moved right by half the canvas width the controls panel covers.
 */
export async function globeViewCentre(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const canvas = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>('aside.atlas-controls');
    const box = panel?.getBoundingClientRect();
    const covered =
      !panel ||
      !box ||
      panel.hidden ||
      box.width === 0 ||
      matchMedia('(max-width: 52rem)').matches
        ? 0
        : Math.min(canvas.width, Math.max(0, box.right - canvas.left));
    return {
      x: canvas.left + canvas.width / 2 + covered / 2,
      y: canvas.top + canvas.height / 2,
    };
  });
}

/**
 * How far west of the camera target the desktop surface tests point. At the inspector camera
 * (1,000 km over Madrid, about 0.9 km per px) that is still one of the e2e fixture's cells, and it
 * keeps the pointer clear of the right rail: at 1280 px the target is drawn at 874 px and an
 * inspector opening in the rail starts near 844 px, where it would lie over the pointer and end its
 * hover.
 */
export const BESIDE_TARGET_PX = 60;

/** A point `BESIDE_TARGET_PX` west of where the camera target is drawn. */
export async function besideGlobeCentre(page: Page): Promise<Point> {
  const centre = await globeViewCentre(page);
  return { x: centre.x - BESIDE_TARGET_PX, y: centre.y };
}

/** The canvas centre in CSS px. */
export async function canvasCentre(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const canvas = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    return {
      x: canvas.left + canvas.width / 2,
      y: canvas.top + canvas.height / 2,
    };
  });
}

export interface GlobeDisc {
  /** The midpoint of the disc's chord across the measured band, in CSS px. */
  centreX: number;
  left: number;
  right: number;
}

/**
 * Finds the magenta disc of a `GLOBE_DISC_QUERY` globe along a 5 px band across the canvas,
 * `above` CSS px above its centre, and returns the chord there in CSS px. Every horizontal chord of
 * the disc is bisected by its vertical diameter, so `above` can move the band clear of a sheet
 * without moving `centreX`. Only the band is captured, and it is decoded in the page, so no image
 * library is needed and a measurement stays quick on a loaded machine.
 */
export async function measureGlobeDisc(
  page: Page,
  above = 0,
): Promise<GlobeDisc> {
  const canvas = await page.evaluate(() => {
    const box = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    return {
      height: box.height,
      left: box.left,
      top: box.top,
      width: box.width,
    };
  });
  const band = {
    height: 5,
    width: canvas.width,
    x: canvas.left,
    y: canvas.top + canvas.height / 2 - above - 2.5,
  };
  const shot = await page.screenshot({ clip: band });
  const chord = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' }),
    );
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    // Magenta, brightened or dimmed by the ground atmosphere; not the bluish sky halo or space.
    const magenta = (index: number) => {
      const [red, green, blue] = [
        data[index],
        data[index + 1],
        data[index + 2],
      ];
      return red >= 120 && blue >= 120 && green <= 0.75 * Math.min(red, blue);
    };
    // The band's middle row; its neighbours only stand in where borders interrupt it.
    const middle = Math.floor(bitmap.height / 2);
    let best = { left: 0, right: -1 };
    for (const row of [middle, middle - 1, middle + 1]) {
      let left = -1;
      let right = -1;
      for (let column = 0; column < bitmap.width; column += 1) {
        if (!magenta((row * bitmap.width + column) * 4)) continue;
        if (left < 0) left = column;
        right = column;
      }
      if (left >= 0 && right - left > best.right - best.left)
        best = { left, right };
    }
    return { ...best, imageWidth: bitmap.width };
  }, shot.toString('base64'));
  const scale = chord.imageWidth / band.width;
  if (chord.right < chord.left)
    return { centreX: Number.NaN, left: Number.NaN, right: Number.NaN };
  return {
    centreX: band.x + (chord.left + chord.right + 1) / 2 / scale,
    left: band.x + chord.left / scale,
    right: band.x + (chord.right + 1) / scale,
  };
}

export interface HeldReadouts {
  posterior: string;
  uncertainty: string;
}

function arrayBufferOf(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * What the hover preview reads for an e2e fixture cell while its artifact's detail tier is held: the
 * render tier's mean and SD behind "≈" (fast-load design §B.2, amended 2026-10-13; #449). The
 * preview no longer names its cell, so the #452 picking tests tell the hovered cell by these
 * readouts. They identify it only when no other fixture cell reads the same, so this refuses any
 * cell that shares them.
 */
export function heldReadoutsOf(id: string, cell: string): HeldReadouts {
  const catalog = atlasCatalogSchema.parse(readE2eCatalog());
  const ref = catalog.artifacts.find((artifact) => artifact.id === id);
  if (!ref) throw new Error(`The e2e catalog has no artifact "${id}".`);
  const gridSha256 = ref.web.grid_sha256;
  const entry = catalog.grids[gridSha256]!;
  const grid = decodeGrid(arrayBufferOf(readE2eObject(entry.url)), {
    entry,
    gridSha256,
  });
  const render = decodeRender(
    arrayBufferOf(readE2eObject(ref.web.render.url)),
    { grid, ref },
  );
  const cells = Array.from({ length: grid.n }, (_, row) => ({
    h3: splitLongToH3Index(grid.h3Lo[row]!, grid.h3Hi[row]!),
    posterior: `≈${percent(render.post_mean[row]!)}`,
    uncertainty: `≈${percent(render.post_sd[row]!)}`,
  }));
  const target = cells.find(({ h3 }) => h3 === cell);
  if (!target) throw new Error(`The e2e fixture grid has no cell ${cell}.`);
  const twins = cells.filter(
    ({ h3, posterior, uncertainty }) =>
      h3 !== cell &&
      posterior === target.posterior &&
      uncertainty === target.uncertainty,
  );
  if (twins.length > 0)
    throw new Error(
      `${id} cell ${cell} reads ${target.posterior} / ${target.uncertainty}, as do ` +
        `${twins.map(({ h3 }) => h3).join(', ')}; a hover cannot tell them apart.`,
    );
  return { posterior: target.posterior, uncertainty: target.uncertainty };
}
