/**
 * Exact scan conversion of the draped rasters' fan meshes (terrain draping design, "Per layer under
 * World Terrain" and "Failure modes": gap-free seams, polar and antimeridian cells, #483).
 *
 * Coverage is exact along shared edges. Each vertex longitude is brought within 180° of its cell
 * centre by whole turns, and every ±360° copy whose box meets the tile is drawn, the integer turn
 * count summed first so a vertex the copy does not shift keeps its exact value. A texel is inside a
 * triangle when its centre is on the inner side of all three edges, or on an edge the top-left rule
 * gives it; each edge function is evaluated with its endpoints in lexicographic order, so the two
 * triangles on a shared edge compute exact negations and every texel centre belongs to one of them.
 * Attributes (colour bytes, or mask st) are interpolated barycentrically in the tile's texel frame,
 * that is in degrees. Each texel's writer also gets every attribute's change across one texel,
 * along a row and along a column: the triangle's exact gradient, or at a pole the central
 * difference, so a texel formula that needs a screen derivative has one.
 *
 * A row whose unwrapped corners span more than 180° of longitude holds a pole. There a texel is
 * inside when it lies poleward of the ring, sorted by longitude, joined by straight lon/lat segments
 * and closed across ±180°, so it meets its neighbours' straight edges; its attributes come from the
 * fan triangle holding it in the azimuthal frame (x, y) = (90° − |lat|)(cos lon, sin lon).
 *
 * Cesium-free and deterministic: the data worker runs it.
 */

import { tileRectangle, turnsNear } from './tiling';
import {
  RASTER_TILE_SIZE,
  type DegreeRectangle,
  type TileAddress,
} from './types';

const SIZE = RASTER_TILE_SIZE;
const DEGREES = Math.PI / 180;
/** The most attributes a mesh vertex may carry. */
export const MAX_MESH_DIMS = 4;

/** Triangles over shared vertices in degrees, each vertex carrying `dims` attributes. */
export interface Mesh {
  lon: number[];
  lat: number[];
  /** `dims` values per vertex: sRGB bytes (3) for fills, st (2) for masks, and room for one more,
   * such as the normalised value a contour reads. */
  attrs: number[];
  /** 1 to `MAX_MESH_DIMS`. */
  dims: number;
  /** The writer reads `dColumn` and `dRow`. A fan triangle has them at no cost; a pole-holding row
   * computes them only when this is set, and hands zeros otherwise. */
  derivatives: boolean;
  /** Vertex indices, three per triangle. */
  triangles: number[];
}

/** Writes one texel from the interpolated attributes `v`. `dColumn[d]` and `dRow[d]` are attribute
 * `d`'s change across one texel along a row and along a column, as a fragment's `dFdx` and `dFdy`
 * give them. */
export type TexelWriter = (
  rgba: Uint8ClampedArray,
  offset: number,
  v: Float64Array,
  dColumn: Float64Array,
  dRow: Float64Array,
) => void;

/** A tile being drawn: its texels, frame and scratch state. */
export interface Target {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  rect: DegreeRectangle;
  /** Degrees per tile side, as `toTexel` takes it. */
  span: number;
  written: boolean;
  /** Scratch: interpolated attributes, their value at a run's first texel, their change per
   * column and per row, a row's real span and the triangle being drawn. */
  value: Float64Array;
  base: Float64Array;
  dColumn: Float64Array;
  dRow: Float64Array;
  run: Float64Array;
  triangle: Triangle;
}

/** An empty tile at `a` to draw into. */
export function scanTarget(a: TileAddress): Target {
  return {
    base: new Float64Array(MAX_MESH_DIMS),
    dColumn: new Float64Array(MAX_MESH_DIMS),
    dRow: new Float64Array(MAX_MESH_DIMS),
    rect: tileRectangle(a),
    rgba: new Uint8ClampedArray(SIZE * SIZE * 4),
    run: new Float64Array(2),
    span: 180 / 2 ** a.level,
    triangle: {
      own01: false,
      own12: false,
      own20: false,
      sign: 1,
      x0: 0,
      x1: 0,
      x2: 0,
      y0: 0,
      y1: 0,
      y2: 0,
    },
    value: new Float64Array(MAX_MESH_DIMS),
    written: false,
  };
}

function checkDims(m: Mesh): void {
  if (!(Number.isInteger(m.dims) && m.dims >= 1 && m.dims <= MAX_MESH_DIMS))
    throw new Error(
      `a raster mesh carries 1 to ${MAX_MESH_DIMS} attributes per vertex, not ${m.dims}`,
    );
}

/** The edge function E(p) = (b − a) × (p − a), evaluated with the endpoints in lexicographic order
 * and the sign flipped back, so the reversed edge gives the exact negation. */
function edgeAt(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  if (ax < bx || (ax === bx && ay < by))
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  return -((ax - bx) * (py - by) - (ay - by) * (px - bx));
}

/** Top-left rule for the edge a → b of a counter-clockwise triangle: it owns the texel centres on
 * it when the inside lies towards +x, or towards +y for a horizontal edge. */
function owns(ax: number, ay: number, bx: number, by: number): boolean {
  return by < ay || (by === ay && bx > ax);
}

/** A triangle in the tile's texel-centre frame, with the top-left ownership of its edges taken
 * counter-clockwise. */
export interface Triangle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 1 when (0, 1, 2) runs counter-clockwise, −1 when it runs clockwise. */
  sign: number;
  own12: boolean;
  own20: boolean;
  own01: boolean;
}

/** True when the texel centre (column, row) lies on the inner side of every edge, or on an edge the
 * top-left rule gives it. */
function inside(tr: Triangle, column: number, row: number): boolean {
  const e12 = tr.sign * edgeAt(tr.x1, tr.y1, tr.x2, tr.y2, column, row);
  if (e12 < 0 || (e12 === 0 && !tr.own12)) return false;
  const e20 = tr.sign * edgeAt(tr.x2, tr.y2, tr.x0, tr.y0, column, row);
  if (e20 < 0 || (e20 === 0 && !tr.own20)) return false;
  const e01 = tr.sign * edgeAt(tr.x0, tr.y0, tr.x1, tr.y1, column, row);
  return !(e01 < 0 || (e01 === 0 && !tr.own01));
}

/** Narrows `span` = [lo, hi] to where `row` crosses the inner side of the counter-clockwise edge
 * a → b, as real numbers; the exact tests then settle each end. */
function narrow(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  row: number,
  span: Float64Array,
): void {
  const dy = by - ay;
  if (dy === 0) return;
  const x = ax + ((bx - ax) * (row - ay)) / dy;
  if (dy < 0) {
    if (x > span[0]) span[0] = x;
  } else if (x < span[1]) span[1] = x;
}

/** Draws triangle `k` of `m`, whose vertices sit at (xs, ys) in the tile's texel-centre frame.
 *
 * Each edge function is monotone along a row in floating point (every operation in it is), so the
 * texels that pass the exact test form one run per row: the real crossings bound it to within a
 * texel, the exact test finds both ends, and every texel between them is inside. Attributes are
 * affine along the run, from the exact barycentric weights at its first texel. */
function scanTriangle(
  t: Target,
  m: Mesh,
  k: number,
  xs: Float64Array,
  ys: Float64Array,
  write: TexelWriter,
): void {
  const i0 = m.triangles[k];
  const i1 = m.triangles[k + 1];
  const i2 = m.triangles[k + 2];
  const x0 = xs[i0];
  const y0 = ys[i0];
  const x1 = xs[i1];
  const y1 = ys[i1];
  const x2 = xs[i2];
  const y2 = ys[i2];
  const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2)));
  const maxX = Math.min(SIZE - 1, Math.floor(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2)));
  const maxY = Math.min(SIZE - 1, Math.floor(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;
  const signed = edgeAt(x0, y0, x1, y1, x2, y2);
  if (!(signed !== 0)) return;
  const ccw = signed > 0;
  const area = Math.abs(signed);
  const tr = t.triangle;
  tr.x0 = x0;
  tr.y0 = y0;
  tr.x1 = x1;
  tr.y1 = y1;
  tr.x2 = x2;
  tr.y2 = y2;
  tr.sign = ccw ? 1 : -1;
  tr.own12 = ccw ? owns(x1, y1, x2, y2) : owns(x2, y2, x1, y1);
  tr.own20 = ccw ? owns(x2, y2, x0, y0) : owns(x0, y0, x2, y2);
  tr.own01 = ccw ? owns(x0, y0, x1, y1) : owns(x1, y1, x0, y0);
  const { attrs, dims } = m;
  for (let d = 0; d < dims; d += 1) {
    const a0 = attrs[i0 * dims + d];
    const a1 = attrs[i1 * dims + d];
    const a2 = attrs[i2 * dims + d];
    t.dColumn[d] = (-(y2 - y1) * a0 - (y0 - y2) * a1 - (y1 - y0) * a2) / signed;
    t.dRow[d] = ((x2 - x1) * a0 + (x0 - x2) * a1 + (x1 - x0) * a2) / signed;
  }
  const span = t.run;
  for (let row = minY; row <= maxY; row += 1) {
    span[0] = -Infinity;
    span[1] = Infinity;
    if (ccw) {
      narrow(x1, y1, x2, y2, row, span);
      narrow(x2, y2, x0, y0, row, span);
      narrow(x0, y0, x1, y1, row, span);
    } else {
      narrow(x2, y2, x1, y1, row, span);
      narrow(x0, y0, x2, y2, row, span);
      narrow(x1, y1, x0, y0, row, span);
    }
    let first = Math.max(minX, Math.floor(span[0]) - 1);
    let last = Math.min(maxX, Math.ceil(span[1]) + 1);
    while (first <= last && !inside(tr, first, row)) first += 1;
    while (last > first && !inside(tr, last, row)) last -= 1;
    if (first > last) continue;
    const w0 = (tr.sign * edgeAt(x1, y1, x2, y2, first, row)) / area;
    const w1 = (tr.sign * edgeAt(x2, y2, x0, y0, first, row)) / area;
    const w2 = (tr.sign * edgeAt(x0, y0, x1, y1, first, row)) / area;
    for (let d = 0; d < dims; d += 1)
      t.base[d] =
        w0 * attrs[i0 * dims + d] +
        w1 * attrs[i1 * dims + d] +
        w2 * attrs[i2 * dims + d];
    for (let column = first; column <= last; column += 1) {
      for (let d = 0; d < dims; d += 1)
        t.value[d] = t.base[d] + t.dColumn[d] * (column - first);
      write(t.rgba, (row * SIZE + column) * 4, t.value, t.dColumn, t.dRow);
    }
    t.written = true;
  }
}

/** Draws a mesh that holds no pole, for each ±360° copy whose box meets the tile. Vertex 0 is the
 * cell centre, which every other vertex is unwrapped towards. */
export function drawMesh(t: Target, m: Mesh, write: TexelWriter): void {
  checkDims(m);
  const n = m.lon.length;
  const turns = m.lon.map((lon) => turnsNear(lon, m.lon[0]));
  const unwrapped = m.lon.map((lon, v) => lon + 360 * turns[v]);
  const west = Math.min(...unwrapped);
  const east = Math.max(...unwrapped);
  if (Math.min(...m.lat) > t.rect.north || Math.max(...m.lat) < t.rect.south)
    return;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let v = 0; v < n; v += 1)
    ys[v] = ((m.lat[v] - t.rect.south) * SIZE) / t.span - 0.5;
  for (const shift of [-1, 0, 1]) {
    if (west + 360 * shift > t.rect.east || east + 360 * shift < t.rect.west)
      continue;
    for (let v = 0; v < n; v += 1)
      xs[v] =
        ((m.lon[v] + 360 * (turns[v] + shift) - t.rect.west) * SIZE) / t.span -
        0.5;
    for (let k = 0; k < m.triangles.length; k += 3)
      scanTriangle(t, m, k, xs, ys, write);
  }
}

/** Latitude of the pole ring at `lon`; `lons` is sorted and closed across ±180°. */
function ringLatAt(lons: number[], lats: number[], lon: number): number {
  for (let k = 0; k + 1 < lons.length; k += 1)
    if (lon <= lons[k + 1] && lons[k + 1] > lons[k])
      return (
        lats[k] +
        ((lats[k + 1] - lats[k]) * (lon - lons[k])) / (lons[k + 1] - lons[k])
      );
  return lats[lats.length - 1];
}

/** The azimuthal frame about the pole: (90° − |lat|)(cos lon, sin lon). */
function azimuthal(lon: number, lat: number): [number, number] {
  const r = 90 - Math.abs(lat);
  return [r * Math.cos(lon * DEGREES), r * Math.sin(lon * DEGREES)];
}

/** Barycentric weights of (px, py) in triangle `k` of the azimuthal vertices (ax, ay). */
function weightsIn(
  m: Mesh,
  k: number,
  ax: number[],
  ay: number[],
  px: number,
  py: number,
): [number, number, number] {
  const [i0, i1, i2] = [m.triangles[k], m.triangles[k + 1], m.triangles[k + 2]];
  const area =
    (ax[i1] - ax[i0]) * (ay[i2] - ay[i0]) -
    (ay[i1] - ay[i0]) * (ax[i2] - ax[i0]);
  const w1 =
    ((px - ax[i0]) * (ay[i2] - ay[i0]) - (py - ay[i0]) * (ax[i2] - ax[i0])) /
    area;
  const w2 =
    ((ax[i1] - ax[i0]) * (py - ay[i0]) - (ay[i1] - ay[i0]) * (px - ax[i0])) /
    area;
  return [1 - w1 - w2, w1, w2];
}

/** `m`'s attributes at (lon, lat) through triangle `k`, written into `out`; weights below 0 are
 * clamped when `clamp` is set (the texel itself), kept for the st differences around it. */
function interpolateAt(
  m: Mesh,
  k: number,
  ax: number[],
  ay: number[],
  lon: number,
  lat: number,
  clamp: boolean,
  out: Float64Array,
): void {
  let w = weightsIn(m, k, ax, ay, ...azimuthal(lon, lat));
  if (clamp) {
    const kept = w.map((weight) => Math.max(0, weight));
    const sum = kept[0] + kept[1] + kept[2];
    w = [kept[0] / sum, kept[1] / sum, kept[2] / sum];
  }
  for (let d = 0; d < m.dims; d += 1)
    out[d] =
      w[0] * m.attrs[m.triangles[k] * m.dims + d] +
      w[1] * m.attrs[m.triangles[k + 1] * m.dims + d] +
      w[2] * m.attrs[m.triangles[k + 2] * m.dims + d];
}

/** Draws a pole-holding row: inside poleward of `ring`, attributes from the mesh triangle that
 * holds the texel best (the largest smallest weight) in the azimuthal frame, and, when the mesh
 * asks for them, their central differences over one texel through that triangle. */
export function drawPolar(
  t: Target,
  ring: { lon: number[]; lat: number[] },
  m: Mesh,
  north: boolean,
  write: TexelWriter,
): void {
  checkDims(m);
  const edge = north ? Math.min(...ring.lat) : Math.max(...ring.lat);
  if (north ? edge > t.rect.north : edge < t.rect.south) return;
  const { dims } = m;
  t.dColumn.fill(0);
  t.dRow.fill(0);
  const order = ring.lon
    .map((_, k) => k)
    .sort((p, q) => ring.lon[p] - ring.lon[q]);
  const [first, last] = [order[0], order[order.length - 1]];
  const lons = [
    ring.lon[last] - 360,
    ...order.map((k) => ring.lon[k]),
    ring.lon[first] + 360,
  ];
  const lats = [
    ring.lat[last],
    ...order.map((k) => ring.lat[k]),
    ring.lat[first],
  ];
  const corners = m.lon.map((lon, v) => azimuthal(lon, m.lat[v]));
  const ax = corners.map(([x]) => x);
  const ay = corners.map(([, y]) => y);
  const half = t.span / SIZE / 2;
  const around = new Float64Array(4 * MAX_MESH_DIMS);
  for (let column = 0; column < SIZE; column += 1) {
    const lon = t.rect.west + ((column + 0.5) * t.span) / SIZE;
    const boundary = ringLatAt(lons, lats, lon - 360 * Math.round(lon / 360));
    for (let row = 0; row < SIZE; row += 1) {
      const lat = t.rect.south + ((row + 0.5) * t.span) / SIZE;
      if (north ? lat < boundary : lat > boundary) continue;
      const [px, py] = azimuthal(lon, lat);
      let best = 0;
      let bestMin = -Infinity;
      for (let k = 0; k < m.triangles.length; k += 3) {
        const smallest = Math.min(...weightsIn(m, k, ax, ay, px, py));
        if (smallest > bestMin) [best, bestMin] = [k, smallest];
      }
      interpolateAt(m, best, ax, ay, lon, lat, true, t.value);
      if (m.derivatives) {
        const probes: [number, number][] = [
          [lon - half, lat],
          [lon + half, lat],
          [lon, lat - half],
          [lon, lat + half],
        ];
        probes.forEach(([x, y], p) =>
          interpolateAt(
            m,
            best,
            ax,
            ay,
            x,
            y,
            false,
            around.subarray(p * dims, (p + 1) * dims),
          ),
        );
        for (let d = 0; d < dims; d += 1) {
          t.dColumn[d] = around[dims + d] - around[d];
          t.dRow[d] = around[3 * dims + d] - around[2 * dims + d];
        }
      }
      write(t.rgba, (row * SIZE + column) * 4, t.value, t.dColumn, t.dRow);
      t.written = true;
    }
  }
}

/** True when some texel centre of the tile lies in `box` or one of its ±360° copies. */
export function touchesTexel(t: Target, box: DegreeRectangle): boolean {
  const toY = (lat: number) => ((lat - t.rect.south) * SIZE) / t.span - 0.5;
  const rows =
    Math.max(0, Math.ceil(toY(box.south))) <=
    Math.min(SIZE - 1, Math.floor(toY(box.north)));
  if (!rows) return false;
  return [-1, 0, 1].some((shift) => {
    const toX = (lon: number) =>
      ((lon + 360 * shift - t.rect.west) * SIZE) / t.span - 0.5;
    return (
      Math.max(0, Math.ceil(toX(box.west))) <=
      Math.min(SIZE - 1, Math.floor(toX(box.east)))
    );
  });
}
