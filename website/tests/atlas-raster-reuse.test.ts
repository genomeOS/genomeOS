/**
 * What the draped surface raster reuses between tiles (terrain draping design, "Per layer under
 * World Terrain" and "Performance budget and measurement", #483). At production density a level-0
 * tile holds about 39,000 rows, so per-tile work per row must be the scan alone: each masked
 * cell's H3 boundary and st frame are built once per grid, each row's colour once per style, and a
 * restyle on the same grid recolours without touching the boundaries. `atlas-raster-bytes.test.ts`
 * pins that the bytes stay the same.
 */

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

function maskedRows(input: SurfaceRasterInput): number {
  return input.support.filter(
    (code) => code === UNKNOWN_CODE || code === PRIOR_DOMINATED_CODE,
  ).length;
}

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
});
