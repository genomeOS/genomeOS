/**
 * Tile rectangles and the texel frame of the draped Atlas rasters (terrain draping design, "Per
 * layer under World Terrain" and "Builder's calls", #483).
 *
 * Tiles follow Cesium's `GeographicTilingScheme`: two 180° roots at level 0, `y` counted from the
 * north, so a tile of `level` spans Δ = 180 / 2^level degrees on each side. Within a tile, texel
 * rows are south-first: row 0 is the southernmost. The texel-centre frame puts the centre of texel
 * (column, row) at (column, row), so the tile's south-west corner is (−0.5, −0.5). A cell's
 * vertices are unwrapped towards its centre by whole turns (`turnsNear`), which the grid index and
 * the scan share.
 */

import {
  RASTER_TILE_SIZE,
  type DegreeRectangle,
  type TileAddress,
} from './types';

/** The whole turns that bring `lon` to within 180° of `near`: `lon + 360 × turnsNear(lon, near)`. */
export function turnsNear(lon: number, near: number): number {
  return -Math.round((lon - near) / 360);
}

/** Degrees along each side of a tile of `level`. */
function tileSpan(level: number): number {
  return 180 / 2 ** level;
}

/** The tile's rectangle in degrees, as `GeographicTilingScheme.tileXYToRectangle` gives it. */
export function tileRectangle(a: TileAddress): DegreeRectangle {
  const span = tileSpan(a.level);
  return {
    east: -180 + (a.x + 1) * span,
    north: 90 - a.y * span,
    south: 90 - (a.y + 1) * span,
    west: -180 + a.x * span,
  };
}

/** The centre of texel (column, row) in degrees; row 0 lies along the south edge. */
export function texelCentre(
  a: TileAddress,
  column: number,
  row: number,
): { lon: number; lat: number } {
  const span = tileSpan(a.level);
  return {
    lat: 90 - (a.y + 1) * span + ((row + 0.5) * span) / RASTER_TILE_SIZE,
    lon: -180 + a.x * span + ((column + 0.5) * span) / RASTER_TILE_SIZE,
  };
}

/** (lon, lat) in the tile's texel-centre frame: the centre of texel (c, r) is (c, r). */
export function toTexel(
  a: TileAddress,
  lon: number,
  lat: number,
): { x: number; y: number } {
  const span = tileSpan(a.level);
  const west = -180 + a.x * span;
  const south = 90 - (a.y + 1) * span;
  return {
    x: ((lon - west) * RASTER_TILE_SIZE) / span - 0.5,
    y: ((lat - south) * RASTER_TILE_SIZE) / span - 0.5,
  };
}
