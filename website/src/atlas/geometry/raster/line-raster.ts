/**
 * Anti-aliased lines in the draped Atlas rasters (terrain draping design, "Per layer under World
 * Terrain": cell edges as the `atlas-outlines` layer, 1.5–2 texel lines in the matched or fixed
 * colour at α 0.92, drawn from level 3; country borders as the `atlas-borders` layer; sampling
 * footprints as the `atlas-footprints` layer, never in the surface texture; "Builder's calls" 3, 4
 * and 12; "Failure modes": polar and antimeridian lines, #483).
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
 * never a line around the world. A line along ±180° fills the edge tiles on both sides.
 *
 * Outlines are the closed `h3PolygonParts` rings of the supported rows, the rings `buildEdgeChunk`
 * draws on the smooth globe, coloured `brighterEdgeBytes(bin colour)` (matched) or the fixed
 * `#rrggbb`; masked cells have none. Coarser than `OUTLINE_MIN_LEVEL`, a line would cover the whole
 * cell, so those tiles stay empty.
 *
 * Borders are the Natural Earth rings the context overlay draws, `BORDER_WIDTH_TEXELS` wide at
 * every level and opaque (the layer's α is the country opacity). Natural Earth splits its rings at
 * ±180°, so a border segment whose ends lie more than 180° of longitude apart is an error, never a
 * line around the world. A tile finds its segments in a 1° segment index, built once per borders
 * copy, and every vertex is checked when it is built: no border is dropped silently.
 *
 * Footprints ring each observation's sampling circle as `samplingRingSamples` does on the smooth
 * globe (observation-layer.ts): `FOOTPRINT_RING_SEGMENTS` vertices from due north on the
 * 6,371.0088 km sphere, `FOOTPRINT_WIDTH_TEXELS` wide at `FOOTPRINT_ALPHA`, inside left clear. A
 * ring is unwrapped along its length, so one across ±180° draws on both sides and one round a pole
 * is a band across every longitude.
 *
 * Bounds are the lines' vertex extent grown by `BOUNDS_MARGIN_DEGREES`; where that passes ±180° it
 * takes every longitude, since its strokes reach the other side. Nothing here is stochastic: a tile
 * repeats byte for byte.
 *
 * The segment index (`segment-index.ts`) and the footprint rings (`footprint-rings.ts`) are their
 * own modules, re-exported here.
 */

import {
  brighterEdgeBytes,
  EDGE_ALPHA,
  type EdgeColorSpec,
} from '../edge-buffers';
import type { NaturalEarthBuffers } from '../natural-earth';
import { h3PolygonParts } from '../polygon-parts';
import { isSupportedCode } from '../support-codes';
import { paletteBins, type PaletteBins } from '../surface-buffers';
import { cellLanes } from '../topology';
import { FOOTPRINT_RING_POINTS, footprintRings } from './footprint-rings';
import { buildSegmentIndex, type SegmentIndex } from './segment-index';
import { tileRectangle } from './tiling';
import {
  OUTLINE_MIN_LEVEL,
  OUTLINE_WIDTH_TEXELS,
  RASTER_MAX_LEVEL,
  RASTER_TILE_SIZE,
  type DegreeRectangle,
  type SurfaceRasterInput,
  type TileAddress,
  type TileRaster,
} from './types';

export {
  FOOTPRINT_RING_SEGMENTS,
  footprintRing,
  validateFootprintCircles,
} from './footprint-rings';
export {
  buildSegmentIndex,
  SEGMENT_BUCKET_DEGREES,
  type SegmentIndex,
} from './segment-index';

type Rgb = readonly [number, number, number];

/** Whole turns a segment copy is shifted by: the segment itself and its ±360° copies. */
const COPY_TURNS = [0, -1, 1] as const;

/** Country border width in texels, at every level. */
export const BORDER_WIDTH_TEXELS = 1.65;
/** Sampling footprint ring width in texels. */
export const FOOTPRINT_WIDTH_TEXELS = 2;
/** Sampling footprint α, the smooth globe's ring material α. */
export const FOOTPRINT_ALPHA = 0.9;
/** How far border and footprint bounds reach beyond their vertices, in degrees. */
export const BOUNDS_MARGIN_DEGREES = 1;

/** Texels from a line's centre to the edge of its anti-aliased band. */
function reachTexels(widthTexels: number): number {
  return widthTexels / 2 + 0.5;
}

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
  const reach = reachTexels(widthTexels);
  const grow = reach + 0.5;
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

/** One index per borders copy; building it checks every vertex and segment. */
const BORDER_INDEX = new WeakMap<NaturalEarthBuffers, SegmentIndex>();

function borderIndex(borders: NaturalEarthBuffers): SegmentIndex {
  let index = BORDER_INDEX.get(borders);
  if (!index) {
    index = buildSegmentIndex(borders.lonLat, borders.ringOffsets);
    BORDER_INDEX.set(borders, index);
  }
  return index;
}

/** A vertex extent grown by `BOUNDS_MARGIN_DEGREES`; every longitude where that passes ±180°. */
function grownBounds(
  west: number,
  south: number,
  east: number,
  north: number,
): DegreeRectangle {
  const margin = BOUNDS_MARGIN_DEGREES;
  const wraps = west - margin < -180 || east + margin > 180;
  return {
    east: wraps ? 180 : east + margin,
    north: Math.min(90, north + margin),
    south: Math.max(-90, south - margin),
    west: wraps ? -180 : west - margin,
  };
}

/** The borders' extent, `BOUNDS_MARGIN_DEGREES` out; null for no rings. Checks the borders as
 * `buildSegmentIndex` does. */
export function borderBounds(
  borders: NaturalEarthBuffers,
): DegreeRectangle | null {
  borderIndex(borders);
  const { lonLat } = borders;
  if (lonLat.length === 0) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < lonLat.length; k += 2) {
    west = Math.min(west, lonLat[k]);
    east = Math.max(east, lonLat[k]);
    south = Math.min(south, lonLat[k + 1]);
    north = Math.max(north, lonLat[k + 1]);
  }
  return grownBounds(west, south, east, north);
}

/** Reused for each border tile's segment query; the worker rasterises one tile at a time. */
const SEGMENTS: number[] = [];

/** The country borders of tile `a`: every segment within reach of it, `BORDER_WIDTH_TEXELS` wide
 * and opaque in `color`. Null for a tile with nothing drawn. */
export function rasterBorderTile(
  i: { borders: NaturalEarthBuffers; color: string },
  a: TileAddress,
): TileRaster | null {
  const rgb = rgbOfHex(i.color);
  const index = borderIndex(i.borders);
  const rect = tileRectangle(a);
  const pad =
    (reachTexels(BORDER_WIDTH_TEXELS) * (rect.east - rect.west)) /
    RASTER_TILE_SIZE;
  const segments = index.segmentsIn(
    {
      east: rect.east + pad,
      north: rect.north + pad,
      south: rect.south - pad,
      west: rect.west - pad,
    },
    SEGMENTS,
  );
  if (segments.length === 0) return null;
  const rgba = new Uint8ClampedArray(RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4);
  let wrote = false;
  for (const v of segments)
    if (
      strokeInto(
        rgba,
        a,
        i.borders.lonLat,
        v,
        v + 2,
        BORDER_WIDTH_TEXELS,
        rgb,
        1,
      )
    )
      wrote = true;
  return wrote ? { rgba } : null;
}

/** The footprints' extent, `BOUNDS_MARGIN_DEGREES` beyond their rings; null for no circles. A
 * ring across ±180° or round a pole takes every longitude. */
export function footprintBounds(circles: Float64Array): DegreeRectangle | null {
  const { boxes, count } = footprintRings(circles);
  if (count === 0) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let ring = 0; ring < count; ring += 1) {
    const b = grownBounds(
      boxes[4 * ring],
      boxes[4 * ring + 1],
      boxes[4 * ring + 2],
      boxes[4 * ring + 3],
    );
    west = Math.min(west, b.west);
    east = Math.max(east, b.east);
    south = Math.min(south, b.south);
    north = Math.max(north, b.north);
  }
  return { east, north, south, west };
}

/** The sampling footprints of tile `a`: each ring within reach of it, `FOOTPRINT_WIDTH_TEXELS`
 * wide at `FOOTPRINT_ALPHA` in `color`, inside left clear. Null for a tile with nothing drawn. */
export function rasterFootprintTile(
  i: { circles: Float64Array; color: string },
  a: TileAddress,
): TileRaster | null {
  const rgb = rgbOfHex(i.color);
  const { boxes, count, lonLat } = footprintRings(i.circles);
  const rect = tileRectangle(a);
  const pad =
    (reachTexels(FOOTPRINT_WIDTH_TEXELS) * (rect.east - rect.west)) /
    RASTER_TILE_SIZE;
  let rgba: Uint8ClampedArray<ArrayBuffer> | null = null;
  let wrote = false;
  for (let ring = 0; ring < count; ring += 1) {
    const west = boxes[4 * ring];
    const south = boxes[4 * ring + 1];
    const east = boxes[4 * ring + 2];
    const north = boxes[4 * ring + 3];
    if (south - pad > rect.north || north + pad < rect.south) continue;
    if (
      !COPY_TURNS.some(
        (turns) =>
          west + 360 * turns - pad <= rect.east &&
          east + 360 * turns + pad >= rect.west,
      )
    )
      continue;
    rgba ??= new Uint8ClampedArray(RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4);
    if (
      strokeInto(
        rgba,
        a,
        lonLat,
        ring * FOOTPRINT_RING_POINTS,
        (ring + 1) * FOOTPRINT_RING_POINTS,
        FOOTPRINT_WIDTH_TEXELS,
        rgb,
        FOOTPRINT_ALPHA,
      )
    )
      wrote = true;
  }
  return wrote && rgba ? { rgba } : null;
}
