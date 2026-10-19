/**
 * What the draped surface raster reuses between tiles (terrain draping design, "Per layer under
 * World Terrain" and "Performance budget and measurement", #483). At production density a level-0
 * tile holds about 39,000 rows, so per-tile work per row must be the scan alone: each masked
 * cell's H3 boundary and st frame are built once per grid, each row's colour once per style, and a
 * restyle on the same grid recolours without touching the boundaries. `atlas-raster-bytes.test.ts`
 * pins that the bytes stay the same. What is kept is kept by its input's columns, so nothing of an
 * input stays reachable once its tiles are drawn and the input is let go: a full collection, which
 * Node runs on demand here as Jest's leak detector does, takes it.
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { cellToBoundary, gridDisk, latLngToCell } from 'h3-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rasterSurfaceTile } from '../src/atlas/geometry/raster/fill-raster';
import type { SurfaceRasterInput } from '../src/atlas/geometry/raster/types';
import {
  isSupportedCode,
  PRIOR_DOMINATED_CODE,
  UNKNOWN_CODE,
} from '../src/atlas/geometry/support-codes';
import type { Support } from '../src/atlas/contracts';
import { colorBytesAtStops } from '../src/atlas/visual-encoding';
import { sortedU64 } from './helpers/mesh-input';
import { rasterInputFor, tilesCovering } from './helpers/raster-fixtures';

// Both stay real; the spies only count the calls.
vi.mock('h3-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3-js')>();
  return { ...actual, cellToBoundary: vi.fn(actual.cellToBoundary) };
});
vi.mock('../src/atlas/visual-encoding', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/atlas/visual-encoding')>();
  return { ...actual, colorBytesAtStops: vi.fn(actual.colorBytesAtStops) };
});

const SUPPORT_CYCLE: readonly Support[] = [
  'observed',
  'unknown',
  'interpolated',
  'prior_dominated',
];

/** 91 res-4 cells round Nairobi, every support code in turn. */
const CELLS = sortedU64(gridDisk(latLngToCell(-1.836, 36.793, 4), 5)).map(
  (h3, row) => ({
    h3,
    support: SUPPORT_CYCLE[row % SUPPORT_CYCLE.length],
    value: (row % 7) / 6,
  }),
);

/** Draws every tile of each level that holds one of the input's cells. */
function drawLevels(input: SurfaceRasterInput, levels: number[]): void {
  for (const level of levels)
    for (const a of tilesCovering(input, level)) rasterSurfaceTile(input, a);
}

/** Every tile of each level that holds one of the input's cells, as drawn: its bytes, or null. */
function tileBytes(
  input: SurfaceRasterInput,
  levels: number[],
): (Uint8ClampedArray | null)[] {
  return levels.flatMap((level) =>
    tilesCovering(input, level).map(
      (a) => rasterSurfaceTile(input, a)?.rgba.slice() ?? null,
    ),
  );
}

/** How many of two equal-length tile lists' tiles differ in any byte. */
function differingTiles(
  a: (Uint8ClampedArray | null)[],
  b: (Uint8ClampedArray | null)[],
): number {
  expect(a).toHaveLength(b.length);
  return a.filter((tile, k) => {
    const other = b[k];
    return tile === null || other === null
      ? tile !== other
      : tile.some((byte, at) => byte !== other[at]);
  }).length;
}

function maskedRows(input: SurfaceRasterInput): number {
  return input.support.filter(
    (code) => code === UNKNOWN_CODE || code === PRIOR_DOMINATED_CODE,
  ).length;
}

/** A full garbage collection, on demand. */
setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

let input: SurfaceRasterInput;

beforeEach(() => {
  input = rasterInputFor(CELLS);
  vi.mocked(cellToBoundary).mockClear();
  vi.mocked(colorBytesAtStops).mockClear();
});

describe('per-tile work of the surface raster (#483)', () => {
  it('builds each masked cell’s H3 boundary once per grid, however many tiles draw it', () => {
    expect(maskedRows(input)).toBeGreaterThan(0);
    drawLevels(input, [5, 0, 1, 2, 3, 4]);
    expect(vi.mocked(cellToBoundary)).toHaveBeenCalledTimes(maskedRows(input));
  });

  it('colours each row once per style: tiles after the first draw of every row compute no colour', () => {
    expect(input.support.some((code) => isSupportedCode(code))).toBe(true);
    drawLevels(input, [5]);
    expect(vi.mocked(colorBytesAtStops)).toHaveBeenCalled();
    vi.mocked(colorBytesAtStops).mockClear();
    drawLevels(input, [0, 1, 2, 3, 4, 5]);
    expect(vi.mocked(colorBytesAtStops)).not.toHaveBeenCalled();
  });

  it('recolours a restyle on the same grid and keeps its mask boundaries', () => {
    drawLevels(input, [5]);
    vi.mocked(cellToBoundary).mockClear();
    vi.mocked(colorBytesAtStops).mockClear();
    const restyled: SurfaceRasterInput = { ...input, palette: 'viridis' };
    drawLevels(restyled, [5]);
    expect(vi.mocked(colorBytesAtStops)).toHaveBeenCalled();
    expect(vi.mocked(cellToBoundary)).not.toHaveBeenCalled();
    vi.mocked(colorBytesAtStops).mockClear();
    drawLevels(restyled, [0, 1, 2, 3, 4]);
    expect(vi.mocked(colorBytesAtStops)).not.toHaveBeenCalled();
  });

  it('draws a restyle on the same values as a cold draw of that style: its palette and domain key the kept colours', () => {
    expect(input.palette).toBe('rainbow');
    const levels = [3, 5];
    // Every row's colour kept under the rainbow style, as a worker keeps it on its render tier.
    const rainbow = tileBytes(input, levels);
    for (const [what, restyle] of [
      ['palette', { palette: 'viridis' }],
      ['domain', { domain: [input.domain[0], 2 * input.domain[1]] }],
    ] as const) {
      const warm = tileBytes({ ...input, ...restyle }, levels);
      // A copy of the values shares no kept colour, so it draws the style from nothing.
      const cold = tileBytes(
        { ...input, ...restyle, values: Float32Array.from(input.values) },
        levels,
      );
      expect(differingTiles(warm, rainbow), what).toBeGreaterThan(0);
      expect(differingTiles(warm, cold), what).toBe(0);
    }
  });

  it('holds nothing of an input once its tiles are drawn and it is let go', async () => {
    const held = (() => {
      // Its own input, so no test variable holds it.
      const own = rasterInputFor(CELLS);
      drawLevels(own, [5, 2]);
      return { input: new WeakRef(own), values: new WeakRef(own.values) };
    })();
    // A weak reference holds its target until the job that made it ends.
    for (let pass = 0; pass < 3; pass += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collectGarbage();
    }
    expect({
      input: held.input.deref() === undefined,
      values: held.values.deref() === undefined,
    }).toEqual({ input: true, values: true });
  });
});
