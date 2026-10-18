/**
 * Full-grid coverage of the draped surface raster (terrain draping design, "Test plan": on the full
 * hbs-rs334 grid, every supported cell's centre texel at level 8 has its colour; one miss fails,
 * #483). It runs when `ATLAS_DATA_DIR` names a staging tree holding the full grids, and is skipped
 * otherwise, like the other full-grid suites.
 */

import { describe, expect, it } from 'vitest';

import { buildGridIndex } from '../src/atlas/geometry/raster/grid-index';
import type {
  DrapedGeometry,
  SurfaceRasterInput,
} from '../src/atlas/geometry/raster/types';
import { isSupportedCode } from '../src/atlas/geometry/support-codes';
import { paletteBins } from '../src/atlas/geometry/surface-buffers';
import {
  buildGridTopology,
  type GridTopology,
} from '../src/atlas/geometry/topology';
import {
  FULL_GRID_SURFACE,
  hasFullGrid,
  surfaceFixture,
  type SurfaceFixture,
} from './helpers/atlas-geometry';
import { centreTexel } from './helpers/raster-fixtures';

let loaded: {
  fixture: SurfaceFixture;
  topology: GridTopology;
  index: ReturnType<typeof buildGridIndex>;
} | null = null;

/** The published HbS surface's render tier (f32 post_mean) as a rasteriser input, both cell sets
 * drawn; the grid, topology and index are read once. */
function fullGridRasterInput(
  path: string,
  geometry: DrapedGeometry,
): SurfaceRasterInput {
  if (!loaded) {
    const fixture = surfaceFixture(path);
    const topology = buildGridTopology(fixture.grid);
    loaded = { fixture, index: buildGridIndex(topology), topology };
  }
  const { fixture, index, topology } = loaded;
  return {
    cells: { masked: true, supported: true },
    contours: false,
    domain: fixture.artifact.metric_domains.post_mean,
    geometry,
    grid: fixture.grid,
    index,
    palette: 'rainbow',
    support: fixture.support,
    topology,
    values: fixture.post_mean,
  };
}

function supportedRows(input: SurfaceRasterInput): number[] {
  const rows: number[] = [];
  for (let row = 0; row < input.grid.n; row += 1)
    if (isSupportedCode(input.support[row])) rows.push(row);
  return rows;
}

function sameColour(
  actual: readonly number[],
  expected: readonly number[],
): boolean {
  return actual.every((value, channel) => value === expected[channel]);
}

describe.skipIf(!hasFullGrid)(
  'full-grid coverage (#483: never drop a row)',
  () => {
    it("colours every supported cell's centre texel at level 8 on the full hbs-rs334 grid", () => {
      const input = fullGridRasterInput(FULL_GRID_SURFACE!, 'hexagons');
      const bins = paletteBins(input, 'supported');
      expect(supportedRows(input).length).toBeGreaterThan(0);
      const misses = supportedRows(input).filter(
        (row) =>
          !sameColour(centreTexel(input, row, 8), [
            ...bins.colors.get(bins.binOfRow[row])!,
            255,
          ]),
      );
      expect(misses).toEqual([]);
    }, 180_000);

    it("covers every supported cell's centre texel at level 8 in smooth triangles", () => {
      const input = fullGridRasterInput(FULL_GRID_SURFACE!, 'triangles');
      expect(
        supportedRows(input).filter(
          (row) => centreTexel(input, row, 8)[3] !== 255,
        ),
      ).toEqual([]);
    }, 180_000);
  },
);
