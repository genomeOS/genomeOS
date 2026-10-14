/**
 * The slimmed brand SVGs draw as the owner's artwork does (site redesign #454, ruling 12;
 * scripts/brand-svg.mjs).
 *
 * Each served file is drawn beside its exact counterpart, the same file with the artwork's own path
 * data, at every size the site draws it, at 1x and 2x. A zero-difference gate would pass only the
 * original bytes: Chromium samples each pixel on four sub-scanlines, so moving an edge by a
 * ten-thousandth of a unit can flip one sample and move that pixel by about 64 levels (writing
 * the exact coordinates as relative steps does that much). The gate is the renderer's own floor
 * instead: the slimmed file may change no more pixels, by any amount or by more than 8 levels, than
 * drawing the original 0.02 user units to the side does. That is under 1/50 px at every size here.
 * Colour is compared premultiplied, so colour under zero alpha does not count.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { CROPS, exactCrop, FULL_ARTWORK_COPY } from '../scripts/brand-svg.mjs';

const publicDir = path.resolve(import.meta.dirname, '../public');
const artwork = readFileSync(
  path.join(publicDir, 'brand/genomeos-foundation-dark.svg'),
  'utf8',
);
const osGroup = (svg: string) =>
  svg.match(/^ {2}<g id="wordmark-os"[\s\S]*?^ {2}<\/g>$/m)![0];

/** Each served brand file, its exact counterpart, and the CSS widths the site draws it at. */
async function brandPairs(page: Page) {
  const served = async (file: string) => {
    const response = await page.request.get(`/${file}`);
    expect(response.status(), file).toBe(200);
    return response.text();
  };
  const favicon = await served('favicon.svg');
  return [
    {
      // The header lockup: compact (2.6rem), the phone's landing (14rem) and landing (3.6rem).
      file: 'brand/genomeos-lockup-dark.svg',
      exact: exactCrop(artwork, CROPS['brand/genomeos-lockup-dark.svg']),
      widths: [217.6, 252, 301.3],
    },
    {
      // The Atlas header's wordmark: the phone's 0.96rem and the desktop's 1.6rem tall.
      file: 'brand/genomeos-wordmark-dark.svg',
      exact: exactCrop(artwork, CROPS['brand/genomeos-wordmark-dark.svg']),
      widths: [105.4, 175.7],
    },
    // The footer's full artwork, 22rem wide.
    { file: FULL_ARTWORK_COPY, exact: artwork, widths: [396] },
    {
      // Tab icon sizes and the Atlas pill's mark (1.2rem and 1.3rem).
      file: 'favicon.svg',
      exact: favicon.replace(osGroup(favicon), osGroup(artwork)),
      widths: [16, 21.6, 23.4, 32, 48],
    },
  ].map(async (pair) => ({ ...pair, slim: await served(pair.file) }));
}

/** The SVG with its root viewBox moved `delta` user units right and down. */
function shifted(svg: string, delta: number) {
  return svg.replace(/viewBox="([^"]+)"/, (_, box: string) => {
    const [x, y, width, height] = box.split(' ').map(Number);
    return `viewBox="${x! + delta} ${y! + delta} ${width} ${height}"`;
  });
}

test('the slimmed brand SVGs change no more pixels than a 0.02-unit shift of the original @desktop-chromium', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/404.html');
  for (const pair of await Promise.all(await brandPairs(page))) {
    expect(pair.slim, pair.file).not.toBe(pair.exact);
    const results = await page.evaluate(
      async ({ exact, slim, shift, widths }) => {
        const draw = async (svg: string, width: number, height: number) => {
          const url = URL.createObjectURL(
            new Blob([svg], { type: 'image/svg+xml' }),
          );
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(width);
          canvas.height = Math.ceil(height);
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0, width, height);
          URL.revokeObjectURL(url);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [, , boxWidth, boxHeight] = exact
          .match(/viewBox="([^"]+)"/)![1]!
          .split(' ')
          .map(Number);
        /** Pixels that differ at all, and by more than 8 levels, premultiplied. */
        const compare = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let any = 0;
          let over8 = 0;
          for (let index = 0; index < a.length; index += 4) {
            let delta = Math.abs(a[index + 3]! - b[index + 3]!);
            for (let channel = 0; channel < 3; channel += 1)
              delta = Math.max(
                delta,
                Math.abs(
                  (a[index + channel]! * a[index + 3]!) / 255 -
                    (b[index + channel]! * b[index + 3]!) / 255,
                ),
              );
            if (Math.round(delta) > 0) any += 1;
            if (Math.round(delta) > 8) over8 += 1;
          }
          return { any, over8 };
        };
        const out = [];
        for (const width of widths)
          for (const scale of [1, 2]) {
            const w = width * scale;
            const h = (w * boxHeight!) / boxWidth!;
            const reference = await draw(exact, w, h);
            out.push({
              at: `${width} px at ${scale}x`,
              slim: compare(reference, await draw(slim, w, h)),
              floor: compare(reference, await draw(shift, w, h)),
            });
          }
        return out;
      },
      {
        exact: pair.exact,
        slim: pair.slim,
        shift: shifted(pair.exact, 0.02),
        widths: pair.widths,
      },
    );
    for (const { at, slim, floor } of results) {
      const where = `${pair.file}, ${at}: slim ${JSON.stringify(slim)}, 0.02-unit shift ${JSON.stringify(floor)}`;
      // The floor is not empty, or the gate would pass nothing but identical bytes.
      expect(floor.any, where).toBeGreaterThan(0);
      expect(slim.any, where).toBeLessThanOrEqual(floor.any);
      expect(slim.over8, where).toBeLessThanOrEqual(floor.over8);
    }
  }
});
