/**
 * Cell sets and texel readers for the draped raster tests (terrain draping design, "Per layer under
 * World Terrain" and "Failure modes", #483).
 *
 * The Kenya disk is arbitrary unit-test data; it is not the e2e peak. The seam and pole disks are
 * the polar and antimeridian cases the design's seam tests name.
 */

import { gridDisk, latLngToCell } from 'h3-js';

import { buildGridIndex } from '../../src/atlas/geometry/raster/grid-index';
import { texelCentre } from '../../src/atlas/geometry/raster/tiling';
import {
  RASTER_TILE_SIZE,
  type DrapedGeometry,
  type SurfaceRasterInput,
  type SurfaceRasterSpec,
  type TileAddress,
  type TileRaster,
} from '../../src/atlas/geometry/raster/types';
import type { PaletteId } from '../../src/atlas/visual-encoding';
import { meshInputFor, sortedU64, type TestCell } from './mesh-input';

export type { TestCell } from './mesh-input';

/** A sorted disk of observed cells, each valued by `value(row)`. */
function observedDisk(
  centre: string,
  k: number,
  value: (row: number) => number,
): TestCell[] {
  return sortedU64(gridDisk(centre, k)).map((h3, row): TestCell => ({
    h3,
    support: 'observed',
    value: value(row),
  }));
}

/** 37 res-4 cells around (-1.836, 36.793), all observed, valued `(row % 7) / 6`. */
export const KENYA_CELLS: TestCell[] = observedDisk(
  latLngToCell(-1.836, 36.793, 4),
  3,
  (row) => (row % 7) / 6,
);

/** The res-4 cell at (0, 180) and its ring, observed at 0.5: some cross ±180°. */
export function seamCells(): TestCell[] {
  return observedDisk(latLngToCell(0, 180, 4), 1, () => 0.5);
}

/** The res-4 cell holding the north pole and its ring, observed at 0.5. */
export function poleCells(): TestCell[] {
  return observedDisk(latLngToCell(90, 0, 4), 1, () => 0.5);
}

/** A rasteriser input over `cells`, which must be listed in ascending u64 order. Defaults:
 * triangles, the rainbow palette, domain [0, 1], both cell sets drawn, no contours. */
export function rasterInputFor(
  cells: TestCell[],
  o: {
    geometry?: DrapedGeometry;
    cells?: SurfaceRasterSpec['cells'];
    palette?: PaletteId;
  } = {},
): SurfaceRasterInput {
  const geometry = o.geometry ?? 'triangles';
  const mesh = meshInputFor(cells, { geometry, palette: o.palette });
  return {
    cells: o.cells ?? { masked: true, supported: true },
    contours: false,
    domain: mesh.domain,
    geometry,
    grid: mesh.grid,
    index: buildGridIndex(mesh.topology),
    palette: mesh.palette,
    support: mesh.support,
    topology: mesh.topology,
    values: mesh.values,
  };
}

/** The tile of `level` holding (lon, lat); the east and south edges belong to the last tile. */
export function tileContaining(
  lon: number,
  lat: number,
  level: number,
): TileAddress {
  const span = 180 / 2 ** level;
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(value, 0), max);
  return {
    level,
    x: clamp(Math.floor((lon + 180) / span), 2 ** (level + 1) - 1),
    y: clamp(Math.floor((90 - lat) / span), 2 ** level - 1),
  };
}

/** The RGBA bytes of the texel at (column, row), row 0 southernmost. */
export function texel(
  raster: TileRaster,
  column: number,
  row: number,
): [number, number, number, number] {
  const { rgba } = raster;
  const offset = (row * RASTER_TILE_SIZE + column) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

/** Visits every texel of the tile at `a`, south row first, with its centre. */
export function forEachTexel(
  raster: TileRaster,
  a: TileAddress,
  visit: (t: {
    column: number;
    row: number;
    lon: number;
    lat: number;
    rgba: number[];
  }) => void,
): void {
  for (let row = 0; row < RASTER_TILE_SIZE; row += 1)
    for (let column = 0; column < RASTER_TILE_SIZE; column += 1) {
      const { lat, lon } = texelCentre(a, column, row);
      visit({ column, lat, lon, rgba: texel(raster, column, row), row });
    }
}
