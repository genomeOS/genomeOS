/**
 * Playwright helpers for where the Atlas draws its globe (fast-load design §A.1.13, amended
 * 2026-10-13; #452). On desktop the camera's view axis is drawn half the width the controls panel
 * covers to the right of the canvas centre; on a phone, or with the panel hidden, at the centre.
 */

import type { Page } from '@playwright/test';

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
  /** The midpoint of the disc's widest row, in CSS px. */
  centreX: number;
  left: number;
  right: number;
  row: number;
}

/**
 * Finds the magenta disc of a `GLOBE_DISC_QUERY` globe in a screenshot (decoded in the page, so
 * no image library is needed) and returns its widest row in CSS px. Chrome over the disc's top or
 * bottom does not matter: the widest row is the disc's horizontal diameter.
 */
export async function measureGlobeDisc(page: Page): Promise<GlobeDisc> {
  const shot = await page.screenshot();
  return page.evaluate(async (base64) => {
    const canvas = document
      .querySelector('.atlas-scene canvas')!
      .getBoundingClientRect();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' }),
    );
    const scale = bitmap.width / window.innerWidth;
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const x0 = Math.round(canvas.left * scale);
    const y0 = Math.round(canvas.top * scale);
    const width = Math.round(canvas.width * scale);
    const height = Math.round(canvas.height * scale);
    const { data } = context.getImageData(x0, y0, width, height);
    // Magenta, brightened or dimmed by the ground atmosphere; not the bluish sky halo or space.
    const magenta = (index: number) => {
      const [red, green, blue] = [
        data[index],
        data[index + 1],
        data[index + 2],
      ];
      return red >= 120 && blue >= 120 && green <= 0.75 * Math.min(red, blue);
    };
    let best = { left: 0, right: -1, row: 0 };
    for (let row = 0; row < height; row += 1) {
      let left = -1;
      let right = -1;
      for (let column = 0; column < width; column += 1) {
        if (!magenta((row * width + column) * 4)) continue;
        if (left < 0) left = column;
        right = column;
      }
      if (left >= 0 && right - left > best.right - best.left)
        best = { left, right, row };
    }
    const toCss = (value: number, origin: number) => (value + origin) / scale;
    return {
      centreX: toCss((best.left + best.right + 1) / 2, x0),
      left: toCss(best.left, x0),
      right: toCss(best.right + 1, x0),
      row: toCss(best.row, y0),
    };
  }, shot.toString('base64'));
}
