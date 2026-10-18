/**
 * Anti-aliased lines in the draped Atlas rasters (terrain draping design, "Per layer under World
 * Terrain": cell edges as the `atlas-outlines` layer, 1.5–2 texel lines in the matched or fixed
 * colour at α 0.92, drawn from level 3; "Builder's calls" 4 and 12; "Failure modes": antimeridian
 * cells, #483).
 *
 * The stroke law, which the borders and footprints reuse: in the tile's texel-centre frame, a texel
 * whose centre lies d texels from a segment (its projection clamped to the segment's ends) is covered
 * c = clamp(w / 2 + 0.5 − d, 0, 1) by a line w texels wide, so the edge anti-aliases over one texel
 * beyond half the width. It takes the stroke's colour at α = round(alpha · c · 255) only when that
 * exceeds the α already stored: overlapping strokes and the joins of a ring keep the higher α and
 * never add up.
 *
 * Antimeridian: each segment's end is taken to within 180° of its start, and the segment is drawn
 * once more shifted by ±360°, so a ring that crosses ±180° strokes the tiles on both sides of it and
 * never a line around the world.
 *
 * Outlines are the closed `h3PolygonParts` rings of the supported rows, the rings `buildEdgeChunk`
 * draws on the smooth globe, coloured `brighterEdgeBytes(bin colour)` (matched) or the fixed
 * `#rrggbb`; masked cells have none. Coarser than `OUTLINE_MIN_LEVEL`, a line would cover the whole
 * cell, so those tiles stay empty. Nothing here is stochastic: a tile repeats byte for byte.
 */

import {
  brighterEdgeBytes,
  EDGE_ALPHA,
  type EdgeColorSpec,
} from '../edge-buffers';
import { h3PolygonParts } from '../polygon-parts';
import { isSupportedCode } from '../support-codes';
import { paletteBins, type PaletteBins } from '../surface-buffers';
import { cellLanes } from '../topology';
import { tileRectangle } from './tiling';
import {
  OUTLINE_MIN_LEVEL,
  OUTLINE_WIDTH_TEXELS,
  RASTER_MAX_LEVEL,
  RASTER_TILE_SIZE,
  type SurfaceRasterInput,
  type TileAddress,
  type TileRaster,
} from './types';

type Rgb = readonly [number, number, number];

/** Whole turns a segment copy is shifted by: the segment itself and its ±360° copies. */
const COPY_TURNS = [0, -1, 1] as const;

/** Outline width at `level`: 1.5 texels at level 3, 2 at level 11, linear and clamped. */
export function outlineWidthTexels(level: number): number {
  const [narrow, wide] = OUTLINE_WIDTH_TEXELS;
  const t = Math.min(
    1,
    Math.max(
      0,
      (level - OUTLINE_MIN_LEVEL) / (RASTER_MAX_LEVEL - OUTLINE_MIN_LEVEL),
    ),
  );
  return narrow + (wide - narrow) * t;
}

/** `#rrggbb` as sRGB bytes; any other colour is an error. */
function rgbOfHex(color: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error(`line colour must be #rrggbb, got ${color}`);
  return [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

/** Strokes one segment, given in the tile's texel-centre frame; true if a texel was written. Each
 * texel row visits only the columns the segment can reach, and the square root is taken only in the
 * anti-aliased band: the coverage is exactly the stroke law's. */
function strokeSegment(
  rgba: Uint8ClampedArray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  widthTexels: number,
  rgb: Rgb,
  alpha: number,
): boolean {
  const reach = widthTexels / 2 + 0.5;
  const grow = widthTexels / 2 + 1;
  const last = RASTER_TILE_SIZE - 1;
  const firstColumn = Math.max(0, Math.ceil(Math.min(x0, x1) - grow));
  const lastColumn = Math.min(last, Math.floor(Math.max(x0, x1) + grow));
  const firstRow = Math.max(0, Math.ceil(Math.min(y0, y1) - grow));
  const lastRow = Math.min(last, Math.floor(Math.max(y0, y1) + grow));
  if (firstColumn > lastColumn || firstRow > lastRow) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  const reachSquared = reach * reach;
  // Texels within reach − 1 of the segment are covered fully.
  const core = reach - 1;
  const coreSquared = core > 0 ? core * core : -1;
  const full = Math.round(alpha * 255);
  let wrote = false;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const ey = row - y0;
    // A texel of this row within reach of the segment lies within reach of a segment point whose
    // y is within reach of the row; those points span [tLow, tHigh] of the segment.
    let tLow = 0;
    let tHigh = 1;
    if (dy !== 0) {
      const tA = (ey - reach) / dy;
      const tB = (ey + reach) / dy;
      tLow = Math.max(0, Math.min(tA, tB));
      tHigh = Math.min(1, Math.max(tA, tB));
      if (tLow > tHigh) continue;
    } else if (Math.abs(ey) >= reach) continue;
    const xLow = x0 + Math.min(tLow * dx, tHigh * dx);
    const xHigh = x0 + Math.max(tLow * dx, tHigh * dx);
    const from = Math.max(firstColumn, Math.ceil(xLow - reach));
    const to = Math.min(lastColumn, Math.floor(xHigh + reach));
    let offset = (row * RASTER_TILE_SIZE + from) * 4;
    for (let column = from; column <= to; column += 1, offset += 4) {
      if (rgba[offset + 3] >= full) continue;
      const ex = column - x0;
      const t =
        lengthSquared > 0
          ? Math.min(1, Math.max(0, (ex * dx + ey * dy) / lengthSquared))
          : 0;
      const ox = ex - t * dx;
      const oy = ey - t * dy;
      const distanceSquared = ox * ox + oy * oy;
      if (distanceSquared >= reachSquared) continue;
      const value =
        distanceSquared <= coreSquared
          ? full
          : Math.round(
              alpha * Math.min(1, reach - Math.sqrt(distanceSquared)) * 255,
            );
      if (value <= rgba[offset + 3]) continue;
      rgba[offset] = rgb[0];
      rgba[offset + 1] = rgb[1];
      rgba[offset + 2] = rgb[2];
      rgba[offset + 3] = value;
      wrote = true;
    }
  }
  return wrote;
}

/** `strokePolyline`, reporting whether any texel was written. */
function strokeInto(
  rgba: Uint8ClampedArray,
  a: TileAddress,
  lonLat: ArrayLike<number>,
  from: number,
  to: number,
  widthTexels: number,
  rgb: Rgb,
  alpha: number,
): boolean {
  const { east, north, south, west } = tileRectangle(a);
  const span = east - west;
  // How far, in degrees, a stroke may lie outside the tile and still reach into it.
  const margin = ((widthTexels / 2 + 1) * span) / RASTER_TILE_SIZE;
  // Tiling's `toTexel` frame, inlined so the segment loop allocates nothing.
  const toColumn = (lon: number) =>
    ((lon - west) * RASTER_TILE_SIZE) / span - 0.5;
  const toRow = (lat: number) =>
    ((lat - south) * RASTER_TILE_SIZE) / span - 0.5;
  let wrote = false;
  for (let point = from; point < to - 1; point += 1) {
    const lon0 = lonLat[2 * point];
    const lat0 = lonLat[2 * point + 1];
    const lon1 = lonLat[2 * point + 2];
    const lat1 = lonLat[2 * point + 3];
    if (!(
      Number.isFinite(lon0) &&
      Number.isFinite(lat0) &&
      Number.isFinite(lon1) &&
      Number.isFinite(lat1)
    ))
      throw new Error(
        `line points ${point} and ${point + 1} must be finite lon, lat degrees`,
      );
    if (
      Math.max(lat0, lat1) + margin < south ||
      Math.min(lat0, lat1) - margin > north
    )
      continue;
    // Whole turns that bring the end within 180° of the start, in one step however far it lies;
    // an end exactly 180° away keeps its side.
    const reach = lon1 - lon0;
    const endTurns =
      reach > 180
        ? -Math.ceil((reach - 180) / 360)
        : reach < -180
          ? Math.ceil((-180 - reach) / 360)
          : 0;
    for (const turns of COPY_TURNS) {
      const start = lon0 + 360 * turns;
      const end = lon1 + 360 * (endTurns + turns);
      if (
        Math.max(start, end) + margin < west ||
        Math.min(start, end) - margin > east
      )
        continue;
      if (
        strokeSegment(
          rgba,
          toColumn(start),
          toRow(lat0),
          toColumn(end),
          toRow(lat1),
          widthTexels,
          rgb,
          alpha,
        )
      )
        wrote = true;
    }
  }
  return wrote;
}

/** Strokes points `from`..`to − 1` of `lonLat` (interleaved lon, lat degrees) as an open polyline
 * `widthTexels` wide into `raster`, by the stroke law above. Close a ring by repeating its first
 * point. A non-finite point is an error. */
export function strokePolyline(
  raster: TileRaster,
  a: TileAddress,
  lonLat: ArrayLike<number>,
  from: number,
  to: number,
  widthTexels: number,
  rgb: Rgb,
  alpha: number,
): void {
  strokeInto(raster.rgba, a, lonLat, from, to, widthTexels, rgb, alpha);
}

/** Reused for each tile's row query and ring; the worker rasterises one tile at a time. */
const ROWS: number[] = [];
let ring = new Float64Array(32);

/** The part as interleaved lon, lat with its first point repeated at the end. */
function closedRing(part: readonly (readonly [number, number])[]): number {
  const points = part.length + 1;
  if (ring.length < 2 * points) ring = new Float64Array(4 * points);
  for (let k = 0; k < points; k += 1) {
    const [lon, lat] = part[k % part.length];
    ring[2 * k] = lon;
    ring[2 * k + 1] = lat;
  }
  return points;
}

/** The outline colour of each supported row. */
function outlineColour(
  i: SurfaceRasterInput,
  edgeColor: EdgeColorSpec,
): (row: number) => Rgb {
  if (edgeColor.mode === 'fixed') {
    const fixed = rgbOfHex(edgeColor.color);
    return () => fixed;
  }
  const byBin = new Map<number, Rgb>();
  let bins: PaletteBins | null = null;
  return (row) => {
    bins ??= paletteBins(i, 'supported');
    const bin = bins.binOfRow[row];
    let rgb = byBin.get(bin);
    if (!rgb) {
      const bytes = bins.colors.get(bin);
      if (!bytes)
        throw new Error(`supported grid row ${row} has no palette bin colour`);
      rgb = brighterEdgeBytes(bytes);
      byBin.set(bin, rgb);
    }
    return rgb;
  };
}

/** The cell outlines of tile `a`: the supported rows' rings at `EDGE_ALPHA`, `outlineWidthTexels`
 * wide. Null below `OUTLINE_MIN_LEVEL` and for a tile with nothing drawn. */
export function rasterOutlineTile(
  i: SurfaceRasterInput & { edgeColor: EdgeColorSpec },
  a: TileAddress,
): TileRaster | null {
  const colour = outlineColour(i, i.edgeColor);
  if (a.level < OUTLINE_MIN_LEVEL) return null;
  const width = outlineWidthTexels(a.level);
  const rect = tileRectangle(a);
  // A ring up to w / 2 + 0.5 texels outside the tile still reaches into it.
  const pad = ((width / 2 + 1) * (rect.east - rect.west)) / RASTER_TILE_SIZE;
  const rows = i.index.rowsIn(
    {
      east: rect.east + pad,
      north: Math.min(90, rect.north + pad),
      south: Math.max(-90, rect.south - pad),
      west: rect.west - pad,
    },
    ROWS,
  );
  let rgba: Uint8ClampedArray<ArrayBuffer> | null = null;
  let wrote = false;
  for (const row of rows) {
    if (!isSupportedCode(i.support[row])) continue;
    rgba ??= new Uint8ClampedArray(RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4);
    const rgb = colour(row);
    for (const part of h3PolygonParts(cellLanes(i.grid, row))) {
      const points = closedRing(part);
      if (strokeInto(rgba, a, ring, 0, points, width, rgb, EDGE_ALPHA))
        wrote = true;
    }
  }
  return wrote && rgba ? { rgba } : null;
}
