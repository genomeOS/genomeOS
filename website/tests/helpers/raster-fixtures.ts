/**
 * Cell sets, texel readers and chunk references for the draped raster tests (terrain draping
 * design, "Per layer under World Terrain", "Failure modes" and "Test plan", #483).
 *
 * The Kenya disk is arbitrary unit-test data; it is not the e2e peak. The seam and pole disks are
 * the polar and antimeridian cases the design's seam tests name. The chunk references
 * (`lonLatTriangles`, `barycentricColour`) read `buildSurfaceChunk`'s buffers back to degrees
 * through Cesium, so the rasteriser is checked against the smooth globe's own triangles.
 */

import { Cartesian3, Cartographic, Math as CesiumMath } from 'cesium';
import { gridDisk, latLngToCell } from 'h3-js';

import { rasterSurfaceTile } from '../../src/atlas/geometry/raster/fill-raster';
import { buildGridIndex } from '../../src/atlas/geometry/raster/grid-index';
import { texelCentre, toTexel } from '../../src/atlas/geometry/raster/tiling';
import {
  RASTER_TILE_SIZE,
  type DrapedGeometry,
  type SurfaceRasterInput,
  type SurfaceRasterSpec,
  type TileAddress,
  type TileRaster,
} from '../../src/atlas/geometry/raster/types';
import type { SurfaceChunkBuffers } from '../../src/atlas/geometry/surface-buffers';
import { gridRowOf } from '../../src/atlas/geometry/topology';
import type { PaletteId } from '../../src/atlas/visual-encoding';
import { meshInputFor, sortedU64, type TestCell } from './mesh-input';

export type { TestCell } from './mesh-input';
export { wholeGridChunk } from './mesh-input';

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

/** One triangle of a chunk, its corners in degrees and sRGB bytes (as floats). */
export interface LonLatTriangle {
  lon: [number, number, number];
  lat: [number, number, number];
  rgb: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
}

/** The chunk's triangles, each position read back to degrees through `Cartographic.fromCartesian`
 * (the 650 m clearance dropped) and each colour scaled back to bytes. */
export function lonLatTriangles(chunk: SurfaceChunkBuffers): LonLatTriangle[] {
  const scratch = new Cartesian3();
  const corner = (vertex: number) => {
    scratch.x = chunk.positions[vertex * 3];
    scratch.y = chunk.positions[vertex * 3 + 1];
    scratch.z = chunk.positions[vertex * 3 + 2];
    const { latitude, longitude } = Cartographic.fromCartesian(scratch);
    return {
      lat: CesiumMath.toDegrees(latitude),
      lon: CesiumMath.toDegrees(longitude),
      rgb: [0, 1, 2].map((c) => chunk.colors[vertex * 3 + c] * 255) as [
        number,
        number,
        number,
      ],
    };
  };
  const triangles: LonLatTriangle[] = [];
  for (let index = 0; index < chunk.indices.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => corner(chunk.indices[index + k]));
    triangles.push({
      lat: [a.lat, b.lat, c.lat],
      lon: [a.lon, b.lon, c.lon],
      rgb: [a.rgb, b.rgb, c.rgb],
    });
  }
  return triangles;
}

/** Degrees per bucket of the triangle lookup. */
const TRIANGLE_BUCKET_DEGREES = 0.25;
const triangleBuckets = new WeakMap<
  readonly LonLatTriangle[],
  Map<string, number[]>
>();

function bucketKey(lon: number, lat: number): string {
  return `${Math.floor(lon / TRIANGLE_BUCKET_DEGREES)},${Math.floor(lat / TRIANGLE_BUCKET_DEGREES)}`;
}

/** Triangles by the buckets their boxes meet; built once per triangle list. Longitudes are not
 * wrapped, so the reference serves cells that do not cross ±180°. */
function bucketsOf(
  triangles: readonly LonLatTriangle[],
): Map<string, number[]> {
  const cached = triangleBuckets.get(triangles);
  if (cached) return cached;
  const buckets = new Map<string, number[]>();
  triangles.forEach(({ lat, lon }, index) => {
    const step = TRIANGLE_BUCKET_DEGREES;
    for (
      let x = Math.floor(Math.min(...lon) / step);
      x <= Math.floor(Math.max(...lon) / step);
      x += 1
    )
      for (
        let y = Math.floor(Math.min(...lat) / step);
        y <= Math.floor(Math.max(...lat) / step);
        y += 1
      ) {
        const key = `${x},${y}`;
        const list = buckets.get(key);
        if (list) list.push(index);
        else buckets.set(key, [index]);
      }
  });
  triangleBuckets.set(triangles, buckets);
  return buckets;
}

/** The colour the chunk draws at (lon, lat): barycentric in degrees over the triangle holding the
 * point; null when no triangle holds it. */
export function barycentricColour(
  triangles: readonly LonLatTriangle[],
  lon: number,
  lat: number,
): [number, number, number] | null {
  for (const index of bucketsOf(triangles).get(bucketKey(lon, lat)) ?? []) {
    const { lat: y, lon: x, rgb } = triangles[index];
    const area = (x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0]);
    if (area === 0) continue;
    const w1 =
      ((lon - x[0]) * (y[2] - y[0]) - (lat - y[0]) * (x[2] - x[0])) / area;
    const w2 =
      ((x[1] - x[0]) * (lat - y[0]) - (y[1] - y[0]) * (lon - x[0])) / area;
    const w0 = 1 - w1 - w2;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    return [0, 1, 2].map(
      (c) => w0 * rgb[0][c] + w1 * rgb[1][c] + w2 * rgb[2][c],
    ) as [number, number, number];
  }
  return null;
}

/** Every tile of `level` that holds a cell's centre or one of its corners, in row-major order. */
export function tilesCovering(
  input: SurfaceRasterInput,
  level: number,
): TileAddress[] {
  const { topology } = input;
  const tiles = new Map<string, TileAddress>();
  const add = (lon: number, lat: number) => {
    const a = tileContaining(lon, lat, level);
    tiles.set(`${a.y},${a.x}`, a);
  };
  for (let row = 0; row < topology.n; row += 1) {
    add(topology.centreLon[row], topology.centreLat[row]);
    for (
      let k = topology.cornerOffsets[row];
      k < topology.cornerOffsets[row + 1];
      k += 1
    )
      add(
        topology.vertexLon[topology.cornerIds[k]],
        topology.vertexLat[topology.cornerIds[k]],
      );
  }
  return [...tiles.values()].sort((p, q) => p.y - q.y || p.x - q.x);
}

/** The grid row of the cell holding (lon, lat); null off the grid, or when a point one texel of
 * `level` away in any of the eight directions lies in another cell (near a cell edge, where the
 * raster's straight lon/lat edges and H3's geodesic ones may disagree). */
export function rowOfCellAt(
  input: SurfaceRasterInput,
  lon: number,
  lat: number,
  level = 7,
): number | null {
  const { grid } = input;
  const cell = latLngToCell(lat, lon, grid.resolution);
  const step = 180 / 2 ** level / RASTER_TILE_SIZE;
  for (const dx of [-step, 0, step])
    for (const dy of [-step, 0, step])
      if (latLngToCell(lat + dy, lon + dx, grid.resolution) !== cell)
        return null;
  return gridRowOf(grid, cell);
}

/** True when the cell holding (lon, lat) and all its neighbours are on the grid, so the point lies
 * at least a cell inside the grid's outer ring. */
export function insideInnerDisk(
  input: SurfaceRasterInput,
  lon: number,
  lat: number,
): boolean {
  const { grid } = input;
  const cell = latLngToCell(lat, lon, grid.resolution);
  return gridDisk(cell, 1).every((h3) => gridRowOf(grid, h3) !== null);
}

/** Texels of `column` with α > 0. */
export function columnCoverage(raster: TileRaster, column: number): number {
  let count = 0;
  for (let row = 0; row < RASTER_TILE_SIZE; row += 1)
    if (texel(raster, column, row)[3] > 0) count += 1;
  return count;
}

/** The texel rows (row 0 southernmost) holding a texel with α > 0. */
export function drawnRows(raster: TileRaster): number[] {
  const rows: number[] = [];
  for (let row = 0; row < RASTER_TILE_SIZE; row += 1)
    for (let column = 0; column < RASTER_TILE_SIZE; column += 1)
      if (texel(raster, column, row)[3] > 0) {
        rows.push(row);
        break;
      }
  return rows;
}

/** Tiles kept per input by `centreTexel`; rows in grid order are spatially close, so a small cache
 * rasterises each tile about once. */
const CENTRE_TILE_CACHE = 64;
/** The level `centreTexel` reads a lon/lat point at. */
const CENTRE_POINT_LEVEL = 8;
const centreTiles = new WeakMap<
  SurfaceRasterInput,
  Map<string, TileRaster | null>
>();

function cachedTile(
  input: SurfaceRasterInput,
  a: TileAddress,
): TileRaster | null {
  const tiles = centreTiles.get(input) ?? new Map<string, TileRaster | null>();
  centreTiles.set(input, tiles);
  const key = `${a.level}/${a.x}/${a.y}`;
  if (tiles.has(key)) return tiles.get(key)!;
  const raster = rasterSurfaceTile(input, a);
  if (tiles.size >= CENTRE_TILE_CACHE) tiles.delete(tiles.keys().next().value!);
  tiles.set(key, raster);
  return raster;
}

/** The texel holding a point: `(input, row, level)` reads the centre of grid row `row` at `level`;
 * `(input, lon, lat)`, any call whose two numbers are not both integers, reads (lon, lat) at level
 * 8. An empty tile reads as transparent black. */
export function centreTexel(
  input: SurfaceRasterInput,
  lonOrRow: number,
  latOrLevel: number,
): [number, number, number, number] {
  const byRow = Number.isInteger(lonOrRow) && Number.isInteger(latOrLevel);
  const lon = byRow ? input.topology.centreLon[lonOrRow] : lonOrRow;
  const lat = byRow ? input.topology.centreLat[lonOrRow] : latOrLevel;
  const level = byRow ? latOrLevel : CENTRE_POINT_LEVEL;
  const a = tileContaining(lon, lat, level);
  const raster = cachedTile(input, a);
  if (!raster) return [0, 0, 0, 0];
  const { x, y } = toTexel(a, lon, lat);
  const clampTexel = (value: number) =>
    Math.min(RASTER_TILE_SIZE - 1, Math.max(0, Math.floor(value + 0.5)));
  return texel(raster, clampTexel(x), clampTexel(y));
}
