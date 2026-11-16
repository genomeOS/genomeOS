/** The surface cells as the shader draws them, for picks along the pointer's ray (fast-load spec
 * 2026-10-07 §B.6.6; Atlas design §11; #483).
 *
 * The cells near a ray are rebuilt vertex by vertex as `buildSurfaceChunk` and the elevated
 * shader draw them: smooth fans with vertex-mean corners, flat hexagons, and extruded prisms whose
 * wall feet stay unlifted; masked rows are flat support plates. Where a vertex lands is the
 * frame's own (`Place`): the map frame shears it (`map-frame-pick.ts`), the globe raises it along
 * its geocentric radial (`lifted-pick.ts`). Of the cells a walk along the ray reached, the first
 * whose triangles the ray meets wins. Cesium-free.
 */

import { cellToLatLng, cellToVertexes, gridDisk, vertexToLatLng } from 'h3-js';

import { rowForH3, type SurfaceArtifact } from '../surface-columns';
import type { SurfaceGeometry } from '../url-state';
import type { PickRay } from './pick-resolver';
import {
  CPU_EXTRUSION_EPSILON_METRES,
  isSmoothGeometry,
} from './surface-buffers';
import type { Vec3 } from './wgs84';

/** Barycentric slack, so a ray along an edge two cells share meets one of them. */
const EDGE_SLACK = 1e-9;

export interface DrawnMesh {
  clearance: number;
  geometry: SurfaceGeometry;
  /** The tallest lift any row can have at this exaggeration, in metres. */
  maxLift: number;
  surface: SurfaceArtifact;
  /** A row's lift at this exaggeration (0 for masked rows). */
  top(row: number): number;
  /** True for rows the surface mesh draws; the others are flat support plates. */
  meshed(row: number): boolean;
  /**
   * The rows the layers draw now, which a ray can meet; every row when absent, as for a click's
   * depth hit, which only drawn rows can give.
   */
  drawn?(row: number): boolean;
}

/** `[lat, lon]` in degrees, the order h3-js uses. */
export type LatLng = [number, number];

export type Triangle = [Vec3, Vec3, Vec3];

/** Where the frame draws a vertex based at `latLng`, `height` metres up, lifted `lift` metres. */
export type Place = (latLng: LatLng, height: number, lift: number) => Vec3;

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Distance along `ray` to the triangle (Möller–Trumbore), or `null` if it misses. */
export function rayTriangle(
  ray: PickRay,
  [a, b, c]: readonly [Vec3, Vec3, Vec3],
): number | null {
  const first = minus(b, a);
  const second = minus(c, a);
  const p = cross(ray.direction, second);
  const det = dot(first, p);
  if (det === 0) return null;
  const s = minus(ray.origin, a);
  const u = dot(s, p) / det;
  if (u < -EDGE_SLACK || u > 1 + EDGE_SLACK) return null;
  const q = cross(s, first);
  const v = dot(ray.direction, q) / det;
  if (v < -EDGE_SLACK || u + v > 1 + EDGE_SLACK) return null;
  const t = dot(second, q) / det;
  return t >= 0 ? t : null;
}

/** h3-js lookups shared by every candidate of one pick. */
export class CellCache {
  readonly #corners = new Map<string, string[]>();
  readonly #points = new Map<string, LatLng>();
  readonly #rows = new Map<string, number | null>();

  constructor(readonly surface: SurfaceArtifact) {}

  row(cell: string): number | null {
    let row = this.#rows.get(cell);
    if (row === undefined) {
      row = rowForH3(this.surface, cell);
      this.#rows.set(cell, row);
    }
    return row;
  }

  corners(cell: string): string[] {
    let corners = this.#corners.get(cell);
    if (!corners) {
      corners = cellToVertexes(cell);
      this.#corners.set(cell, corners);
    }
    return corners;
  }

  vertex(vertex: string): LatLng {
    let point = this.#points.get(vertex);
    if (!point) {
      point = vertexToLatLng(vertex);
      this.#points.set(vertex, point);
    }
    return point;
  }
}

/**
 * The lift of each corner of a meshed smooth cell: the mean over the grid's
 * meshed cells sharing that corner, as `vertexMeans` computes it (those cells
 * are all in `gridDisk(cell, 1)`).
 */
function cornerLifts(
  cell: string,
  mesh: DrawnMesh,
  cache: CellCache,
): number[] {
  const corners = cache.corners(cell);
  const sums = corners.map(() => 0);
  const counts = corners.map(() => 0);
  for (const near of gridDisk(cell, 1)) {
    const row = cache.row(near);
    if (row === null || !mesh.meshed(row)) continue;
    const shared = cache.corners(near);
    corners.forEach((corner, index) => {
      if (!shared.includes(corner)) return;
      sums[index] += mesh.top(row);
      counts[index] += 1;
    });
  }
  return sums.map((sum, index) => sum / counts[index]);
}

/** The highest lift any of the cell's drawn vertices reaches. */
export function reachOf(
  cell: string,
  mesh: DrawnMesh,
  cache: CellCache,
): number {
  const row = cache.row(cell);
  if (row === null || !mesh.meshed(row)) return 0;
  if (!isSmoothGeometry(mesh.geometry)) return mesh.top(row);
  let reach = 0;
  for (const near of gridDisk(cell, 1)) {
    const other = cache.row(near);
    if (other !== null && mesh.meshed(other))
      reach = Math.max(reach, mesh.top(other));
  }
  return reach;
}

function fan(centre: Vec3, ring: readonly Vec3[]): Triangle[] {
  return ring.map((corner, index) => [
    centre,
    corner,
    ring[(index + 1) % ring.length],
  ]);
}

/** The cell's triangles as drawn in `place`'s frame, its longitudes unwrapped around its centre. */
export function cellTriangles(
  cell: string,
  row: number,
  mesh: DrawnMesh,
  cache: CellCache,
  place: Place,
): Triangle[] {
  const { clearance } = mesh;
  const centre = cellToLatLng(cell);
  const ring = cache.corners(cell).map((vertex): LatLng => {
    const [lat, lon] = cache.vertex(vertex);
    return [lat, lon + 360 * Math.round((centre[1] - lon) / 360)];
  });
  const flat = (height: number, lift: number): Triangle[] =>
    fan(
      place(centre, height, lift),
      ring.map((corner) => place(corner, height, lift)),
    );
  if (!mesh.meshed(row)) return flat(clearance, 0);
  if (isSmoothGeometry(mesh.geometry)) {
    const lifts = cornerLifts(cell, mesh, cache);
    return fan(
      place(centre, clearance, mesh.top(row)),
      ring.map((corner, index) => place(corner, clearance, lifts[index])),
    );
  }
  if (mesh.geometry !== 'extruded') return flat(clearance, mesh.top(row));
  const raised = clearance + CPU_EXTRUSION_EPSILON_METRES;
  const top = mesh.top(row);
  const triangles = flat(raised, top);
  const feet = ring.map((corner) => place(corner, clearance, 0));
  const tops = ring.map((corner) => place(corner, raised, top));
  feet.forEach((foot, index) => {
    const next = (index + 1) % feet.length;
    triangles.push(
      [foot, feet[next], tops[next]],
      [foot, tops[next], tops[index]],
    );
  });
  return triangles;
}

/**
 * The first drawn cell `ray` meets among the cells a walk offers, each with the least lift the
 * walk has reached it at (`slack` is the walk's largest lift step): ties to the lower row, no
 * further along the ray than `limit`. The answer does not depend on the order of the offers.
 */
export class FirstHit {
  /** The first hit's row, or `null` while there is none. */
  row: number | null = null;
  /** How far along the ray the first hit lies, in units of its direction (∞ without one). */
  entry = Number.POSITIVE_INFINITY;
  /** Cells already tested, or never drawn. */
  readonly #settled = new Set<string>();
  /** The reach of each drawn cell offered so far. */
  readonly #reaches = new Map<string, number>();

  constructor(
    readonly ray: PickRay,
    readonly slack: number,
    readonly mesh: DrawnMesh,
    readonly cache: CellCache,
    readonly trianglesOf: (cell: string, row: number) => Triangle[],
    readonly limit = Number.POSITIVE_INFINITY,
  ) {}

  offer(cell: string, lift: number): void {
    if (this.#settled.has(cell)) return;
    const { cache, mesh } = this;
    const row = cache.row(cell);
    let reach = this.#reaches.get(cell);
    if (
      row === null ||
      (reach === undefined && mesh.drawn && !mesh.drawn(row))
    ) {
      this.#settled.add(cell);
      return;
    }
    if (reach === undefined) {
      reach = reachOf(cell, mesh, cache);
      this.#reaches.set(cell, reach);
    }
    // A cell reached only above its own reach (plus one step) holds nothing on the ray; a later
    // offer at a lower lift may still test it.
    if (lift > reach + this.slack) return;
    this.#settled.add(cell);
    for (const triangle of this.trianglesOf(cell, row)) {
      const entry = rayTriangle(this.ray, triangle);
      if (
        entry !== null &&
        entry <= this.limit &&
        (entry < this.entry ||
          (entry === this.entry && this.row !== null && row < this.row))
      ) {
        this.row = row;
        this.entry = entry;
      }
    }
  }
}

/**
 * The row of the first drawn cell `ray` meets among the cells a walk `reached` (each with the
 * least lift the walk reached it at; `slack` is the walk's largest lift step), ties to the lower
 * row, no further along the ray than `limit`; `null` when it meets none.
 */
export function firstRowAmong(
  ray: PickRay,
  reached: ReadonlyMap<string, number>,
  slack: number,
  mesh: DrawnMesh,
  cache: CellCache,
  trianglesOf: (cell: string, row: number) => Triangle[],
  limit = Number.POSITIVE_INFINITY,
): number | null {
  const hit = new FirstHit(ray, slack, mesh, cache, trianglesOf, limit);
  for (const [cell, lift] of reached) hit.offer(cell, lift);
  return hit.row;
}
