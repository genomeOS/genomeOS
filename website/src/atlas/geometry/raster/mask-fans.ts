/**
 * The support masks' fans, kept per grid (terrain draping design, "Per layer under World Terrain":
 * hatch and dots baked into the surface tiles; "Performance budget and measurement", #483).
 *
 * A masked row draws its H3 boundary (`h3BoundaryDegrees`) fanned round the cell centre, each
 * vertex carrying its st in the boundary's tangent-plane frame (`stFrameOf`, `stAt`), as the chunk
 * masks' `flatCellBuffers` meshes them; a pole-holding row draws its `h3PolygonParts`, each part
 * in its own frame and a three-point part unfanned, inside its boundary ring. None of that depends
 * on the style or the tile, only on the grid, so each row's fan is built the first time a tile
 * draws it and kept for the grid (the topology object): later tiles, and restyles on the same grid,
 * make no H3 call and allocate nothing for it. The values are those the per-tile build computed, in
 * the same order, so the tiles keep their bytes (`atlas-raster-bytes.test.ts`).
 *
 * A non-polar fan is packed into one growing pool: its vertex count, then each vertex's lon and lat
 * (degrees) and interleaved st. Cesium-free and deterministic: the data worker runs it.
 */

import type { DecodedGrid } from '../../gosa/types';
import { h3BoundaryDegrees, h3PolygonParts } from '../polygon-parts';
import { stAt, stFrameOf, type StFrame } from '../support-buffers';
import { cellLanes, type GridTopology } from '../topology';
import { geodeticToEcef, type Vec3 } from '../wgs84';
import type { Mesh } from './triangle-scan';

/** A pole-holding row's mask: its parts as one mesh, st per vertex, and its boundary ring. */
export interface PolarMask {
  mesh: Mesh;
  ring: { lon: number[]; lat: number[] };
  /** The cell holds the north pole. */
  north: boolean;
}

interface FanStore {
  /** Each row's fan offset in `pool`; −1 until a tile draws the row. */
  at: Int32Array;
  pool: Float64Array;
  used: number;
  polar: Map<number, PolarMask>;
}

/** Doubles the pool starts with: room for about 2,000 hexagonal fans. */
const INITIAL_POOL = 64 * 1024;

const stores = new WeakMap<GridTopology, FanStore>();

function storeFor(topology: GridTopology): FanStore {
  let store = stores.get(topology);
  if (!store) {
    store = {
      at: new Int32Array(topology.n).fill(-1),
      polar: new Map(),
      pool: new Float64Array(INITIAL_POOL),
      used: 0,
    };
    stores.set(topology, store);
  }
  return store;
}

function ground(lon: number, lat: number): Vec3 {
  const point: Vec3 = [0, 0, 0];
  geodeticToEcef(lon, lat, 0, point);
  return point;
}

function frameOf(points: readonly [number, number][]): StFrame {
  return stFrameOf(points.map(([lon, lat]) => ground(lon, lat)));
}

function checkGrid(grid: DecodedGrid, topology: GridTopology): void {
  if (grid.n !== topology.n)
    throw new Error(
      `mask fans need the topology's own grid: ${grid.n} rows against ${topology.n}`,
    );
}

/** Packs row `row`'s fan: the centre, then the boundary, each with its st in the boundary's frame. */
function packFan(
  store: FanStore,
  grid: DecodedGrid,
  topology: GridTopology,
  row: number,
): number {
  const boundary = h3BoundaryDegrees(cellLanes(grid, row));
  const frame = frameOf(boundary);
  const points: [number, number][] = [
    [topology.centreLon[row], topology.centreLat[row]],
    ...boundary,
  ];
  const count = points.length;
  const size = 1 + 4 * count;
  if (store.used + size > store.pool.length) {
    const grown = new Float64Array(
      Math.max(2 * store.pool.length, store.used + size),
    );
    grown.set(store.pool.subarray(0, store.used));
    store.pool = grown;
  }
  const at = store.used;
  const { pool } = store;
  pool[at] = count;
  points.forEach(([lon, lat], v) => {
    const [s, t] = stAt(frame, ground(lon, lat));
    pool[at + 1 + v] = lon;
    pool[at + 1 + count + v] = lat;
    pool[at + 1 + 2 * count + 2 * v] = s;
    pool[at + 1 + 2 * count + 2 * v + 1] = t;
  });
  store.used += size;
  store.at[row] = at;
  return at;
}

/**
 * Writes row `row`'s fan, which holds no pole, into `into`: lon and lat from vertex 0 (the centre),
 * st as its attributes; the vertex count is returned. Built on the row's first draw, then read
 * back. A fan larger than `into` throws: an H3 cell has at most 10 boundary points.
 */
export function maskFanInto(
  grid: DecodedGrid,
  topology: GridTopology,
  row: number,
  into: { lon: Float64Array; lat: Float64Array; attrs: Float64Array },
): number {
  const store = storeFor(topology);
  let at = store.at[row];
  if (at < 0) {
    checkGrid(grid, topology);
    at = packFan(store, grid, topology, row);
  }
  const { pool } = store;
  const count = pool[at];
  if (into.lon.length < count || into.attrs.length < 2 * count)
    throw new Error(
      `a mask fan of ${count} vertices does not fit its ${into.lon.length}-vertex scratch`,
    );
  for (let v = 0; v < count; v += 1) {
    into.lon[v] = pool[at + 1 + v];
    into.lat[v] = pool[at + 1 + count + v];
    into.attrs[2 * v] = pool[at + 1 + 2 * count + 2 * v];
    into.attrs[2 * v + 1] = pool[at + 1 + 2 * count + 2 * v + 1];
  }
  return count;
}

/** Fan triangles (0, 1 + k, 1 + (k + 1) mod n) round vertex `first` over a ring of `n`. */
function fanOnto(out: number[], first: number, n: number): void {
  for (let k = 0; k < n; k += 1)
    out.push(first, first + 1 + k, first + 1 + ((k + 1) % n));
}

/** Row `row`'s mask when it holds a pole, built on its first draw and kept for the grid. */
export function polarMask(
  grid: DecodedGrid,
  topology: GridTopology,
  row: number,
): PolarMask {
  const store = storeFor(topology);
  const kept = store.polar.get(row);
  if (kept) return kept;
  checkGrid(grid, topology);
  const cell = cellLanes(grid, row);
  const centre: [number, number] = [
    topology.centreLon[row],
    topology.centreLat[row],
  ];
  const lon: number[] = [];
  const lat: number[] = [];
  const attrs: number[] = [];
  const triangles: number[] = [];
  for (const part of h3PolygonParts(cell)) {
    const frame = frameOf(part);
    const first = lon.length;
    const fanned = part.length !== 3;
    for (const [x, y] of fanned ? [centre, ...part] : part) {
      lon.push(x);
      lat.push(y);
      attrs.push(...stAt(frame, ground(x, y)));
    }
    if (fanned) fanOnto(triangles, first, part.length);
    else triangles.push(first, first + 1, first + 2);
  }
  const boundary = h3BoundaryDegrees(cell);
  const mask: PolarMask = {
    mesh: { attrs, derivatives: true, dims: 2, lat, lon, triangles },
    north: centre[1] > 0,
    ring: {
      lat: boundary.map(([, y]) => y),
      lon: boundary.map(([x]) => x),
    },
  };
  store.polar.set(row, mask);
  return mask;
}
