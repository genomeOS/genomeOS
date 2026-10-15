/**
 * What each orbit moon's crew, props and bubbles fill over a work loop (round 2 spec §4.3.2; review
 * of T4, finding 1): data for the label model in orbit-layouts.ts, kept in a module of its own with
 * no runtime imports, so the orbit spec (marketing-contribute-orbit.spec.ts) can check the drawn art against
 * it in the browser.
 */
import type { LayoutId } from './orbit-layouts';
import type { MoonKind } from '../../graphics/astro/props';

/** An axis-aligned box: [left, top, right, bottom]. */
export type Box = [x0: number, y0: number, x1: number, y1: number];

/**
 * What each moon's crew, props and bubbles fill over a work loop: one box per figure or prop, in
 * moon-local units before the depth scale (the centre at 0, 0; y down). Measured in the browser by
 * seeking every 50 ms through each moon's loop at each layout, rounded outwards; the orbit spec
 * (marketing-contribute-orbit.spec.ts) checks the drawing stays inside them, so re-measure if the
 * art or the poses change.
 */
export const FOOTPRINT: Record<LayoutId, Record<MoonKind, Box[]>> = {
  desktop: {
    data: [
      [-137, -208, 29, -64], // A1, walking to the cart and back
      [-42, -216, 109, -69], // A6, mining
      [39, -125, 95, -72], // the ore rock
      [-105, -129, -43, -67], // the cart
      [-6, -202, 86, -97], // the flying data block
    ],
    model: [
      [-113, -229, 91, -51], // A5, probing, hopping, at the easel
      [-21, -129, 22, -85], // the probe
      [25, -145, 100, -63], // the easel
    ],
    ui: [
      [-154, -202, -25, -71], // A4
      [-98, -223, 20, -85], // A2
      [-7, -212, 135, -80], // A3
      [-25, -199, 41, -114], // the screen
      [-157, -194, -118, -159], // the three bubbles
      [76, -212, 115, -176],
      [-70, -229, -32, -194],
    ],
  },
  tablet: {
    data: [
      [-91, -136, 22, -37],
      [-31, -141, 73, -39],
      [22, -80, 61, -42],
      [-68, -83, -25, -40],
      [-3, -132, 55, -60],
    ],
    model: [
      [-76, -152, 62, -29],
      [-14, -83, 15, -52],
      [14, -95, 66, -38],
    ],
    ui: [
      [-100, -132, -11, -41],
      [-65, -144, 17, -49],
      [-9, -137, 89, -46],
      [-18, -128, 28, -69],
      [-112, -138, -74, -102],
      [47, -149, 85, -113],
      [-48, -160, -9, -125],
    ],
  },
  phone: {
    data: [
      [-55, -83, 12, -25],
      [-17, -86, 44, -27],
      [15, -50, 38, -28],
      [-42, -51, -17, -26],
      [-3, -81, 35, -39],
    ],
    model: [
      [-46, -93, 37, -21],
      [-9, -53, 9, -35],
      [10, -59, 41, -26],
    ],
    ui: [
      [-61, -79, -8, -26],
      [-39, -87, 9, -32],
      [-4, -83, 53, -30],
      [-10, -78, 17, -43],
      [-81, -98, -42, -63],
      [26, -105, 65, -70],
      [-31, -112, 7, -76],
    ],
  },
};
