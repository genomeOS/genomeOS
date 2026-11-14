/** Surface picks in Cesium's map frame: Columbus view (perspective) and 2D
 * (fast-load spec 2026-10-07 §B.6.6; Atlas design §11).
 *
 * Outside the globe, Primitive draws each vertex at its projected position.
 * Cesium's default GeographicProjection on WGS84 puts (lon, lat, height) at
 * x = lon·a, y = lat·a (radians, a = 6378137 m), and the world frame holds
 * (height, x, y) (`czm_computePosition` reads `position2D.zxy`). The elevated
 * surface shader adds its geocentric ECEF `elevationNormal` n times the lift in
 * that frame unchanged, so a vertex lifted S metres is drawn at
 * (x + n_y·S, y + n_z·S, height + n_x·S): sheared sideways and only partly
 * raised (about 0.76·S up and 0.65·S north at Madrid, sideways near 90°E, and
 * downwards beyond it). Perspective mode has always been drawn this way (§B.7
 * keeps it), so the pick follows the drawing; the globe's radial projection
 * does not undo this shear.
 *
 * Points are `[x, y, height]` in metres and the ray uses the same order
 * (Cesium's world `(height, x, y)` reordered). The cells drawn near the depth
 * hit are rebuilt vertex by vertex as `buildSurfaceChunk` and the shader draw
 * them: smooth fans with vertex-mean corners, flat hexagons, and extruded
 * prisms whose wall feet stay unlifted. Masked rows are drawn as flat support
 * plates. The first cell the pick ray meets wins. Candidates come from a walk
 * over every lift up to the exaggerated maximum: a point drawn at lift s lies
 * at height clearance + n_x·s, so its base is the ray point at that height
 * less the sideways shear. The walk keeps that ray point within a noise window
 * around the depth hit, so depth-buffer noise inside the window changes
 * nothing, and it still works where the shear is mostly sideways and the
 * hit's height says little about the lift. The drawn cells are rebuilt by `drawn-mesh.ts`, which
 * the globe's hover shares (`lifted-pick.ts`). A hover has no depth hit (owner decision
 * 2026-11-14 on #483): `firstDrawnRowAlong` walks the whole stretch of the ray where a lifted cell
 * can be drawn instead of a noise window, passing the rows the layers do not draw. Cesium-free.
 */

import {
  cellToLatLng,
  getHexagonEdgeLengthAvg,
  gridDisk,
  latLngToCell,
  UNITS,
} from 'h3-js';

import {
  CellCache,
  cellTriangles,
  firstRowAmong,
  type DrawnMesh,
  type LatLng,
  type Triangle,
} from './drawn-mesh';
import type { PickRay } from './pick-resolver';
import { CPU_EXTRUSION_EPSILON_METRES } from './surface-buffers';
import { geodeticToEcef, magnitude, type Vec3 } from './wgs84';

/** GeographicProjection's semimajor axis: the WGS84 maximum radius. */
const MAP_RADIUS = 6378137;
const MAP_WIDTH = 2 * Math.PI * MAP_RADIUS;
const DEGREES_PER_METRE = 180 / (Math.PI * MAP_RADIUS);
/** Upper bound on the walk (a resolution-4 grid at exaggeration 5 takes a few hundred steps). */
const MAX_WALK_STEPS = 4096;
/** The noise window around the depth hit along the ray: 2% of the hit's
 * distance, at least 20 km (Task 69's probe measured up to about 16 km, 0.11%
 * of the distance, in a globe-mode world view). */
const DEPTH_NOISE_FRACTION = 0.02;
const MIN_DEPTH_NOISE_METRES = 20_000;

/** The depth hit and the pointer's ray in the map frame. */
export interface MapFrameHit {
  point: Vec3;
  ray: PickRay | null;
}

export type MapFrameMesh = DrawnMesh;

const toDegrees = (metres: number): number => metres * DEGREES_PER_METRE;
const toMetres = (degrees: number): number => degrees / DEGREES_PER_METRE;
const clampLatitude = (lat: number): number => Math.min(90, Math.max(-90, lat));

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

/** The shader's `elevationNormal` at a base point (VertexWriter normalises the
 * ECEF position), reordered from ECEF (x, y, z) onto the map frame's (x, y, height). */
function shearAt(lon: number, lat: number, clearance: number): Vec3 {
  const ecef: Vec3 = [0, 0, 0];
  geodeticToEcef(lon, lat, clearance, ecef);
  const length = magnitude(ecef);
  return [ecef[1] / length, ecef[2] / length, ecef[0] / length];
}

/** Where the shader draws a vertex based at (lon, lat, height) and lifted `lift` metres. */
function drawnAt(
  [lat, lon]: LatLng,
  height: number,
  lift: number,
  clearance: number,
): Vec3 {
  const shear = shearAt(lon, lat, clearance);
  return [
    toMetres(lon) + shear[0] * lift,
    toMetres(lat) + shear[1] * lift,
    height + shear[2] * lift,
  ];
}

/**
 * `point` moved by whole map widths onto the copy nearest the ray. Cesium
 * returns the depth hit through `cartesianToCartographic`, so a surface the
 * shear pushed past ±180° comes back on the other side of the map.
 */
export function alignToRay(point: Vec3, ray: PickRay): Vec3 {
  const length = magnitude(ray.direction);
  let best = point;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const shift of [-MAP_WIDTH, 0, MAP_WIDTH]) {
    const copy: Vec3 = [point[0] + shift, point[1], point[2]];
    const offset = minus(copy, ray.origin);
    const distance = magnitude(cross(offset, ray.direction)) / length;
    if (distance < bestDistance) {
      best = copy;
      bestDistance = distance;
    }
  }
  return best;
}

/** The stretch of the ray (in units of its direction) within the depth-noise
 * window around the hit. */
interface RayWindow {
  ray: PickRay;
  near: number;
  far: number;
}

function rayWindow(point: Vec3, ray: PickRay | null): RayWindow | null {
  if (!ray || ray.direction[2] === 0) return null;
  const lengthSquared = dot(ray.direction, ray.direction);
  const along = dot(minus(point, ray.origin), ray.direction) / lengthSquared;
  const slack =
    Math.max(
      MIN_DEPTH_NOISE_METRES,
      DEPTH_NOISE_FRACTION * along * Math.sqrt(lengthSquared),
    ) / Math.sqrt(lengthSquared);
  return { far: along + slack, near: Math.max(0, along - slack), ray };
}

/** The ray point at `height`, held within the window; the hit itself when
 * there is no window. */
function anchorAt(point: Vec3, window: RayWindow | null, height: number): Vec3 {
  if (!window) return point;
  const { direction, origin } = window.ray;
  const along = Math.min(
    window.far,
    Math.max(window.near, (height - origin[2]) / direction[2]),
  );
  return [
    origin[0] + direction[0] * along,
    origin[1] + direction[1] * along,
    origin[2] + direction[2] * along,
  ];
}

/**
 * Every cell whose drawn geometry can meet the ray near the hit, with the
 * least lift at which the walk reached it (`slack` is the largest lift step).
 *
 * A drawn point lifted s over the base B lies at height clearance + n_x·s, so
 * on the ray it is the ray point at that height, and B is that point less the
 * sideways shear. The walk follows B over every lift in [0, maxLift], keeping
 * the ray point within a noise window around the depth hit (a missing or level
 * ray anchors it at the hit). Each step moves B by at most a third of an
 * average edge, and each step's cell brings its `gridDisk(cell, 1)`, so every
 * top, wall, fan or plate the ray can meet in the window has its cell reached
 * at no more than its own lift plus one step. Depth noise within the window
 * changes nothing.
 */
function walkCandidates(
  point: Vec3,
  window: RayWindow | null,
  mesh: MapFrameMesh,
): { reached: Map<string, number>; slack: number } {
  const resolution = mesh.surface.grid.resolution;
  const spacing = getHexagonEdgeLengthAvg(resolution, UNITS.m) / 3;
  const sideways = window
    ? Math.hypot(window.ray.direction[0], window.ray.direction[1]) /
      Math.abs(window.ray.direction[2])
    : 0;
  const reached = new Map<string, number>();
  const visited = new Set<string>();
  let base: [number, number] = [point[0], point[1]];
  let lift = 0;
  let slack = 0;
  for (let step = 0; step < MAX_WALK_STEPS; step += 1) {
    let shear: Vec3 = [0, 0, 1];
    // A fixed point: the shear turns by about lift / R per metre B moves.
    for (let pass = 0; pass < 4; pass += 1) {
      shear = shearAt(toDegrees(base[0]), toDegrees(base[1]), mesh.clearance);
      const anchor = anchorAt(point, window, mesh.clearance + shear[2] * lift);
      base = [anchor[0] - shear[0] * lift, anchor[1] - shear[1] * lift];
    }
    const cell = latLngToCell(
      clampLatitude(toDegrees(base[1])),
      toDegrees(base[0]),
      resolution,
    );
    if (!visited.has(cell)) {
      visited.add(cell);
      for (const near of gridDisk(cell, 1))
        if (!reached.has(near)) reached.set(near, lift);
    }
    if (lift >= mesh.maxLift) break;
    // How fast B can move per metre of lift: the sideways shear, plus the
    // anchor sliding along the ray while it is inside the window (bounded
    // everywhere, so no step jumps the window); 10% headroom for the turning shear.
    const speed =
      1.1 * (Math.hypot(shear[0], shear[1]) + sideways * Math.abs(shear[2]));
    const next = Math.min(
      mesh.maxLift,
      lift + (speed > 0 ? spacing / speed : mesh.maxLift),
    );
    slack = Math.max(slack, next - lift);
    lift = next;
  }
  return { reached, slack };
}

/**
 * The cell's triangles as drawn in the map frame. Cesium splits a cell that crosses ±180° at the
 * seam; such a cell is tested whole on both sides of the map.
 */
function drawnTriangles(
  cell: string,
  row: number,
  mesh: MapFrameMesh,
  cache: CellCache,
): Triangle[] {
  const triangles = cellTriangles(
    cell,
    row,
    mesh,
    cache,
    (latLng, height, lift) => drawnAt(latLng, height, lift, mesh.clearance),
  );
  // The corners' longitudes as `cellTriangles` unwrapped them, around the centre's.
  const [, centreLon] = cellToLatLng(cell);
  const lons = cache.corners(cell).map((vertex) => {
    const [, lon] = cache.vertex(vertex);
    return lon + 360 * Math.round((centreLon - lon) / 360);
  });
  const shifts = [0];
  if (Math.max(...lons) > 180) shifts.push(-MAP_WIDTH);
  if (Math.min(...lons) < -180) shifts.push(MAP_WIDTH);
  return shifts.flatMap((shift) =>
    shift === 0
      ? triangles
      : triangles.map(
          (triangle) =>
            triangle.map(([x, y, h]): Vec3 => [x + shift, y, h]) as Triangle,
        ),
  );
}

/**
 * The row of the first drawn cell `ray` meets near `point` (ties to the lower
 * row), or `null` when it meets none of the candidates.
 */
export function firstDrawnRow(
  ray: PickRay,
  point: Vec3,
  mesh: MapFrameMesh,
): number | null {
  return firstRowIn(ray, point, rayWindow(point, ray), mesh);
}

/**
 * A hover's pick (#483), which has no depth hit: the row of the first drawn cell `ray` meets
 * anywhere a lifted cell can be drawn. A drawn point lies at height clearance + n_x·s with
 * |n_x| ≤ 1 and s ≤ `maxLift`, so the walk's window is the stretch of the ray between those
 * heights. A level ray has no such stretch, and meets nothing.
 */
export function firstDrawnRowAlong(
  ray: PickRay,
  mesh: MapFrameMesh,
): number | null {
  const fall = ray.direction[2];
  if (fall === 0) return null;
  const reach = mesh.maxLift + CPU_EXTRUSION_EPSILON_METRES;
  const [first, second] = [mesh.clearance + reach, mesh.clearance - reach].map(
    (height) => (height - ray.origin[2]) / fall,
  );
  const far = Math.max(first, second);
  if (far < 0) return null;
  const near = Math.max(0, Math.min(first, second));
  const middle = (near + far) / 2;
  const point: Vec3 = [
    ray.origin[0] + ray.direction[0] * middle,
    ray.origin[1] + ray.direction[1] * middle,
    ray.origin[2] + ray.direction[2] * middle,
  ];
  return firstRowIn(ray, point, { far, near, ray }, mesh);
}

function firstRowIn(
  ray: PickRay,
  point: Vec3,
  window: RayWindow | null,
  mesh: MapFrameMesh,
): number | null {
  const cache = new CellCache(mesh.surface);
  const { reached, slack } = walkCandidates(point, window, mesh);
  return firstRowAmong(ray, reached, slack, mesh, cache, (cell, row) =>
    drawnTriangles(cell, row, mesh, cache),
  );
}

/**
 * The base under `point` and its lift, read from the hit's height
 * (lift = (height − clearance) / n_x, iterated with the base). This is
 * ill-conditioned where the shear is mostly sideways, so it is only the
 * fallback when no ray is available or the ray meets no candidate.
 */
export function unshearedBase(
  point: Vec3,
  clearance: number,
  maxLift: number,
): { lat: number; lon: number; lift: number } {
  let x = point[0];
  let y = point[1];
  let lift = 0;
  for (let step = 0; step < 8; step += 1) {
    const shear = shearAt(toDegrees(x), toDegrees(y), clearance);
    const raw = shear[2] === 0 ? 0 : (point[2] - clearance) / shear[2];
    lift = Math.min(maxLift, Math.max(0, raw));
    x = point[0] - shear[0] * lift;
    y = point[1] - shear[1] * lift;
  }
  return { lat: clampLatitude(toDegrees(y)), lift, lon: toDegrees(x) };
}
