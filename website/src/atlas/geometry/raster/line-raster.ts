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

type Rgb = readonly [number, number, number];

/** Whole turns a segment copy is shifted by: the segment itself and its ±360° copies. */
const COPY_TURNS = [0, -1, 1] as const;

/** Country border width in texels, at every level. */
export const BORDER_WIDTH_TEXELS = 1.65;
/** Sampling footprint ring width in texels. */
export const FOOTPRINT_WIDTH_TEXELS = 2;
/** Sampling footprint α, the smooth globe's ring material α. */
export const FOOTPRINT_ALPHA = 0.9;
/** Vertices of a footprint ring, as `samplingRingSamples` draws it. */
export const FOOTPRINT_RING_SEGMENTS = 48;
/** Side of a segment index bucket, in degrees. */
export const SEGMENT_BUCKET_DEGREES = 1;
/** How far border and footprint bounds reach beyond their vertices, in degrees. */
export const BOUNDS_MARGIN_DEGREES = 1;

/** The sphere `samplingRingSamples` rings footprints on (observation-layer.ts). */
const EARTH_RADIUS_KM = 6_371.0088;

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

/** Segments of interleaved lon, lat rings by rectangle. */
export interface SegmentIndex {
  /** Each segment whose box meets `r`, or `r` shifted ∓360° where it passes ±180°, once and
   * ascending; `out` is reused when given. Segment v joins vertex v to vertex v + 1 of its ring. */
  segmentsIn(r: DegreeRectangle, out?: number[]): number[];
}

const BUCKET_COLUMNS = 360 / SEGMENT_BUCKET_DEGREES;
const BUCKET_ROWS = 180 / SEGMENT_BUCKET_DEGREES;

function bucketColumn(lon: number): number {
  const column = Math.floor((lon + 180) / SEGMENT_BUCKET_DEGREES);
  return Math.min(BUCKET_COLUMNS - 1, Math.max(0, column));
}

function bucketRow(lat: number): number {
  const row = Math.floor((lat + 90) / SEGMENT_BUCKET_DEGREES);
  return Math.min(BUCKET_ROWS - 1, Math.max(0, row));
}

/** Calls `visit(v)` for each segment v of the rings: vertex v to v + 1 within one ring. */
function forEachSegment(
  ringOffsets: Uint32Array,
  visit: (v: number) => void,
): void {
  for (let ring = 0; ring + 1 < ringOffsets.length; ring += 1)
    for (let v = ringOffsets[ring]; v + 1 < ringOffsets[ring + 1]; v += 1)
      visit(v);
}

/** The border rings' segments in `SEGMENT_BUCKET_DEGREES` buckets over the world, in CSR form: a
 * segment sits in every bucket its box meets. Every ring must hold at least two vertices, each a
 * finite WGS84 lon, lat, and no segment may jump the antimeridian (more than 180° of longitude). */
export function buildSegmentIndex(
  lonLat: Float64Array,
  ringOffsets: Uint32Array,
): SegmentIndex {
  const vertices = lonLat.length / 2;
  if (
    !Number.isInteger(vertices) ||
    ringOffsets.length === 0 ||
    ringOffsets[0] !== 0 ||
    ringOffsets[ringOffsets.length - 1] !== vertices
  )
    throw new Error(
      `border rings must run from vertex 0 to the last of ${vertices} lon, lat vertices`,
    );
  for (let ring = 0; ring + 1 < ringOffsets.length; ring += 1)
    if (ringOffsets[ring + 1] < ringOffsets[ring] + 2)
      throw new Error(`border ring ${ring} has fewer than two vertices`);
  for (let v = 0; v < vertices; v += 1) {
    const lon = lonLat[2 * v];
    const lat = lonLat[2 * v + 1];
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90))
      throw new Error(
        `border vertex ${v} must be finite WGS84 lon, lat degrees, got ${lon}, ${lat}`,
      );
  }
  const buckets = (v: number, visit: (bucket: number) => void) => {
    const [lon0, lat0] = [lonLat[2 * v], lonLat[2 * v + 1]];
    const [lon1, lat1] = [lonLat[2 * v + 2], lonLat[2 * v + 3]];
    if (Math.abs(lon1 - lon0) > 180)
      throw new Error(
        `border segment jumps the antimeridian: vertex ${v} at ${lon0}° to vertex ${v + 1} at ${lon1}°`,
      );
    const lastColumn = bucketColumn(Math.max(lon0, lon1));
    const lastRow = bucketRow(Math.max(lat0, lat1));
    for (let row = bucketRow(Math.min(lat0, lat1)); row <= lastRow; row += 1)
      for (
        let column = bucketColumn(Math.min(lon0, lon1));
        column <= lastColumn;
        column += 1
      )
        visit(row * BUCKET_COLUMNS + column);
  };
  const offsets = new Uint32Array(BUCKET_COLUMNS * BUCKET_ROWS + 1);
  forEachSegment(ringOffsets, (v) =>
    buckets(v, (bucket) => {
      offsets[bucket + 1] += 1;
    }),
  );
  for (let bucket = 0; bucket < BUCKET_COLUMNS * BUCKET_ROWS; bucket += 1)
    offsets[bucket + 1] += offsets[bucket];
  const ids = new Uint32Array(offsets[BUCKET_COLUMNS * BUCKET_ROWS]);
  const fill = offsets.slice(0, -1);
  forEachSegment(ringOffsets, (v) =>
    buckets(v, (bucket) => {
      ids[fill[bucket]] = v;
      fill[bucket] += 1;
    }),
  );
  // A segment is listed once per query: its stamp holds the query that listed it.
  const stamp = new Uint32Array(vertices);
  let query = 0;
  return {
    segmentsIn(r, out = []) {
      out.length = 0;
      if (query === 0xffffffff) {
        stamp.fill(0);
        query = 0;
      }
      query += 1;
      const south = Math.max(-90, r.south);
      const north = Math.min(90, r.north);
      const collect = (westOf: number, eastOf: number) => {
        const west = Math.max(-180, westOf);
        const east = Math.min(180, eastOf);
        if (!(west <= east && south <= north)) return;
        for (let row = bucketRow(south); row <= bucketRow(north); row += 1)
          for (
            let column = bucketColumn(west);
            column <= bucketColumn(east);
            column += 1
          ) {
            const bucket = row * BUCKET_COLUMNS + column;
            for (let k = offsets[bucket]; k < offsets[bucket + 1]; k += 1) {
              const v = ids[k];
              if (stamp[v] === query) continue;
              const lon0 = lonLat[2 * v];
              const lon1 = lonLat[2 * v + 2];
              const lat0 = lonLat[2 * v + 1];
              const lat1 = lonLat[2 * v + 3];
              if (
                Math.min(lon0, lon1) > east ||
                Math.max(lon0, lon1) < west ||
                Math.min(lat0, lat1) > north ||
                Math.max(lat0, lat1) < south
              )
                continue;
              stamp[v] = query;
              out.push(v);
            }
          }
      };
      collect(r.west, r.east);
      if (r.west < -180) collect(r.west + 360, r.east + 360);
      if (r.east > 180) collect(r.west - 360, r.east - 360);
      return out.sort((p, q) => p - q);
    },
  };
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

const FOOTPRINT_CIRCLES_ERROR =
  'sampling footprints must be lon, lat, radius_km triples with a positive radius';

/** Throws unless `circles` is whole triples of a finite WGS84 lon, lat and a finite radius_km > 0. */
export function validateFootprintCircles(circles: Float64Array): void {
  if (circles.length % 3 !== 0)
    throw new Error(
      `${FOOTPRINT_CIRCLES_ERROR}; got ${circles.length} numbers`,
    );
  for (let k = 0; k < circles.length; k += 3) {
    const [lon, lat, radiusKm] = [circles[k], circles[k + 1], circles[k + 2]];
    if (!(
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90 &&
      radiusKm > 0 &&
      Number.isFinite(radiusKm)
    ))
      throw new Error(
        `${FOOTPRINT_CIRCLES_ERROR}; circle ${k / 3} is ${lon}, ${lat}, ${radiusKm}`,
      );
  }
}

/** The ring `radiusKm` round (lon, lat): `segments` vertices at bearings 2πk / segments from due
 * north, as interleaved lon, lat degrees, implicitly closed. Each vertex's lon lies within 180° of
 * the centre's (`samplingRingSamples`' destination formula). */
export function footprintRing(
  lon: number,
  lat: number,
  radiusKm: number,
  segments = FOOTPRINT_RING_SEGMENTS,
): Float64Array {
  const angularDistance = radiusKm / EARTH_RADIUS_KM;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const ringOf = new Float64Array(2 * segments);
  for (let k = 0; k < segments; k += 1) {
    const bearing = (k / segments) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.min(
        1,
        Math.max(
          -1,
          Math.sin(lat1) * Math.cos(angularDistance) +
            Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
        ),
      ),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
      );
    ringOf[2 * k] = (lon2 * 180) / Math.PI;
    ringOf[2 * k + 1] = (lat2 * 180) / Math.PI;
  }
  return ringOf;
}

/** A footprint raster's rings, closed and unwrapped along their length, and their extents. */
interface FootprintRings {
  count: number;
  /** `RING_POINTS` points per ring: the vertices, then the first again. */
  lonLat: Float64Array;
  /** West, south, east, north of each ring, in its unwrapped longitudes. */
  boxes: Float64Array;
}

const RING_POINTS = FOOTPRINT_RING_SEGMENTS + 1;
/** The longitude difference taken to within 180°. */
const wrapped = (degrees: number) => degrees - 360 * Math.round(degrees / 360);

/** One ring set per circles array, which is read once: it must not change afterwards. */
const FOOTPRINT_RINGS = new WeakMap<Float64Array, FootprintRings>();

function footprintRings(circles: Float64Array): FootprintRings {
  const cached = FOOTPRINT_RINGS.get(circles);
  if (cached) return cached;
  validateFootprintCircles(circles);
  const count = circles.length / 3;
  const lonLat = new Float64Array(2 * RING_POINTS * count);
  const boxes = new Float64Array(4 * count);
  const segments = FOOTPRINT_RING_SEGMENTS;
  for (let ring = 0; ring < count; ring += 1) {
    const ringOf = footprintRing(
      circles[3 * ring],
      circles[3 * ring + 1],
      circles[3 * ring + 2],
    );
    // Each point's lon lies within 180° of the last one's, so a ring round a pole spans 360°.
    let lon = wrapped(ringOf[0]);
    let [west, south, east, north] = [lon, Infinity, lon, -Infinity];
    for (let point = 0; point < RING_POINTS; point += 1) {
      const vertex = point % segments;
      if (point > 0)
        lon += wrapped(
          ringOf[2 * vertex] - ringOf[2 * ((vertex + segments - 1) % segments)],
        );
      const lat = ringOf[2 * vertex + 1];
      const at = 2 * (ring * RING_POINTS + point);
      lonLat[at] = lon;
      lonLat[at + 1] = lat;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    boxes.set([west, south, east, north], 4 * ring);
  }
  const rings = { boxes, count, lonLat };
  FOOTPRINT_RINGS.set(circles, rings);
  return rings;
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
        ring * RING_POINTS,
        (ring + 1) * RING_POINTS,
        FOOTPRINT_WIDTH_TEXELS,
        rgb,
        FOOTPRINT_ALPHA,
      )
    )
      wrote = true;
  }
  return wrote && rgba ? { rgba } : null;
}
