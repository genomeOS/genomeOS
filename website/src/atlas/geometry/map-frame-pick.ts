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
 * 2026-11-14 on #483; §B.6.6 as amended that day): `firstDrawnRowAlong` traces where the ray
 * meets each lift's sheared sheet over the stretch of the ray where a lifted cell can be drawn,
 * rather than walking the lift about a hit, passes the rows the layers do not draw, and stops
 * once no cell it could still reach is drawn before the first hit it has found (#506 review).
 *
 * Cost per hover at the production grid (resolution 4), measured 2026-11-14 on an Apple M3 Pro
 * under Node 23.9 (vitest), over synthetic lifted disks of 6,211 and 36,631 extruded cells with
 * 400 random rays (half at 0.5–8.5° pitch) and 64 grazing ones (0.2–2°) each, the fastest of
 * three runs per ray: at exaggeration 5 a mean of 1.8–2.0 ms, p95 4.7–4.9 ms, max 9.6–9.9 ms
 * (without the stop 2.5–3.8, 8.3–12.8 and 13.5–24 ms); at the default exaggeration 1 a mean of
 * 0.4 ms, max 3.1–4.0 ms. The slowest are shallow rays that meet no cell, traced to the edge of
 * the map. Cesium-free.
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
  FirstHit,
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
/**
 * A bound on an H3 cell's circumradius (its centre to its farthest corner), in average edges,
 * with the WGS84 radius over H3's sphere (1.0011) folded in: over every cell of resolutions 0 to
 * 4 the largest is 1.0998 average edges.
 */
const CIRCUMRADIUS_PER_EDGE = 1.25;

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
 * anywhere a lifted cell can be drawn (`hoverRow`).
 */
export function firstDrawnRowAlong(
  ray: PickRay,
  mesh: MapFrameMesh,
): number | null {
  const span = drawnSpan(ray, mesh);
  return span ? hoverRow(ray, span, mesh) : null;
}

/**
 * The stretch of `ray` (in units of its direction, from its origin on) where a lifted cell can
 * be drawn: between the heights clearance ± reach, where |n_x| ≤ 1 and s ≤ the reach, and over
 * the map widened by the reach the shear can carry a point sideways and by the cells Cesium
 * splits at ±180°; null where there is none.
 */
function drawnSpan(ray: PickRay, mesh: MapFrameMesh): [number, number] | null {
  const reach = mesh.maxLift + CPU_EXTRUSION_EPSILON_METRES;
  const margin =
    reach + 2 * getHexagonEdgeLengthAvg(mesh.surface.grid.resolution, UNITS.m);
  const slabs: [number, number][] = [
    [-MAP_WIDTH / 2 - margin, MAP_WIDTH / 2 + margin],
    [-MAP_WIDTH / 4 - margin, MAP_WIDTH / 4 + margin],
    [mesh.clearance - reach, mesh.clearance + reach],
  ];
  let near = 0;
  let far = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const [low, high] = slabs[axis];
    const from = ray.origin[axis];
    const along = ray.direction[axis];
    if (along === 0) {
      if (from < low || from > high) return null;
      continue;
    }
    const first = (low - from) / along;
    const second = (high - from) / along;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
  }
  return near <= far ? [near, far] : null;
}

/**
 * A point of the hover's (t, s) grid: the base whose lift-s point is drawn over or under the ray
 * point, whether the ray point lies above it, and the base's cell once asked for.
 */
interface GridPoint {
  above: boolean;
  base: [number, number];
  lift: number;
  cell?: string;
}

/**
 * The row of the first drawn cell the ray meets in `span`, or `null`.
 *
 * At a ray point P (distance t along the ray) and a lift s there is one base B whose lift-s
 * point is drawn straight over or under P: B = P_xy − n_xy(B)·s, a fixed point that converges
 * since the shear turns by at most about s / R per metre B moves. The ray meets a drawing at
 * lift s where P_h = clearance + n_x(B)·s, which over the (t, s) plane is a curve. A walk over
 * the lift alone follows it as a function of s, which it is not: where the ray runs nearly
 * parallel to a sheared sheet the curve turns back on itself, and from the clearance-height
 * ray point it can start on a stretch past a pole or past 90° of longitude (where lifts lean
 * down) that never meets the cells nearer the camera. So the curve is traced on a grid instead:
 * its points are the grid cells whose corners lie on both sides of it, found from where it
 * crosses the grid's edges and followed cell to cell, and each corner's base brings its
 * `gridDisk(cell, 1)`, offered to the first-hit test with the least lift it was reached at. One
 * grid step in t or s moves B by at most a third of an average edge, so every cell the curve
 * passes over is reached, from the grid cell holding the point (t, s) where the ray meets it. A
 * part of the curve that touches none of the grid's edges, closed on itself inside the grid, is
 * not followed.
 *
 * The span runs on to the map's edge, thousands of kilometres past where a shallow ray meets
 * its first cell (the #506 review measured up to 21 ms a hover over the whole span at
 * resolution 4, exaggeration 5). So the grid cells are explored column by column (the curve can
 * turn back towards the camera, so an earlier column can gain cells again; the lowest waiting
 * column goes first), offering their cells as they come, and the trace stops at a grid line
 * once every column before it is explored and no cell a grid point at or past the line can
 * reach is drawn where the ray runs up to the first hit found (`reachTest`). The curve's
 * crossings of that line are then seeds too, so the grid cells before it include every one the
 * whole trace explores there, a fold that comes back from beyond the line among them. Then any
 * cell the whole trace offers that the ray meets before the hit found is offered from before
 * the line, at no greater lift, so the stop gives the first hit the whole trace gives wherever
 * that hit is the ray's true first one. A stop a fixed few columns past the hit does not: where
 * the shear is nearly sideways the trace can reach the first cell only from far past its hit.
 */
function hoverRow(
  ray: PickRay,
  [near, far]: [number, number],
  mesh: MapFrameMesh,
): number | null {
  const resolution = mesh.surface.grid.resolution;
  const spacing = getHexagonEdgeLengthAvg(resolution, UNITS.m) / 3;
  // How far B moves per metre of the ray point or of lift, past the point's own move: the
  // geocentric normal turns by at most 1.01 / a per map metre.
  const headroom = 1 / (1 - (1.01 * mesh.maxLift) / MAP_RADIUS);
  const across = Math.hypot(ray.direction[0], ray.direction[1]);
  const tSteps = Math.max(
    1,
    Math.ceil(((far - near) * across * headroom) / spacing),
  );
  const sSteps = Math.max(1, Math.ceil((mesh.maxLift * headroom) / spacing));
  const columns = sSteps + 1;
  const points = new Map<number, GridPoint>();
  const at = (i: number, j: number): GridPoint => {
    const key = i * columns + j;
    let point = points.get(key);
    if (point) return point;
    const t = near + ((far - near) * i) / tSteps;
    const lift = (mesh.maxLift * j) / sSteps;
    const x = ray.origin[0] + ray.direction[0] * t;
    const y = ray.origin[1] + ray.direction[1] * t;
    // From B = P_xy, each pass shrinks B's error by a factor of 1.01·s / a or better (under
    // 0.15 at the tallest lift), so four leave under half a kilometre.
    let base: [number, number] = [x, y];
    for (let pass = 0; lift > 0 && pass < 4; pass += 1) {
      const shear = shearAt(
        toDegrees(base[0]),
        toDegrees(base[1]),
        mesh.clearance,
      );
      base = [x - shear[0] * lift, y - shear[1] * lift];
    }
    const up =
      lift > 0
        ? shearAt(toDegrees(base[0]), toDegrees(base[1]), mesh.clearance)[2]
        : 0;
    const height = ray.origin[2] + ray.direction[2] * t;
    point = { above: height >= mesh.clearance + up * lift, base, lift };
    points.set(key, point);
    return point;
  };
  const outOfReach = reachTest(ray, mesh);
  const cache = new CellCache(mesh.surface);
  const hit = new FirstHit(
    ray,
    mesh.maxLift / sSteps,
    mesh,
    cache,
    (cell, row) => drawnTriangles(cell, row, mesh, cache),
  );
  const reached = new Map<string, number>();
  /** Cells whose least lift fell since they were last offered to `hit`. */
  const fresh = new Set<string>();
  const disks = new Map<string, string[]>();
  const reach = (point: GridPoint, lift: number) => {
    const cell = (point.cell ??= latLngToCell(
      clampLatitude(toDegrees(point.base[1])),
      toDegrees(point.base[0]),
      resolution,
    ));
    let disk = disks.get(cell);
    if (!disk) {
      disk = gridDisk(cell, 1);
      disks.set(cell, disk);
    }
    for (const near of disk) {
      const seen = reached.get(near);
      if (seen === undefined || lift < seen) {
        reached.set(near, lift);
        fresh.add(near);
      }
    }
  };
  const offerFresh = () => {
    for (const cell of fresh) hit.offer(cell, reached.get(cell)!);
    fresh.clear();
  };
  const crossed = (a: GridPoint, b: GridPoint) => a.above !== b.above;
  /** The grid cells waiting to be explored, by column. */
  const waiting = new Map<number, number[]>();
  const queued = new Set<number>();
  /** No grid cell waits in a column before this one. */
  let column = 0;
  /** Columns from this one on are not explored. */
  let limit = tSteps;
  const enqueue = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= limit || j >= sSteps) return;
    const key = i * sSteps + j;
    if (queued.has(key)) return;
    queued.add(key);
    const cells = waiting.get(i);
    if (cells) cells.push(j);
    else waiting.set(i, [j]);
    column = Math.min(column, i);
  };
  /** The curve's crossings of grid line `line`, as seeds of the column `side` of it. */
  const seedLine = (line: number, side: number) => {
    for (let j = 0; j < sSteps; j += 1)
      if (crossed(at(line, j), at(line, j + 1))) enqueue(side, j);
  };
  seedLine(0, 0);
  /** Columns whose bottom and top edges are seeded. */
  let seeded = 0;
  while (column < limit) {
    for (; seeded <= column; seeded += 1) {
      if (crossed(at(seeded, 0), at(seeded + 1, 0))) enqueue(seeded, 0);
      if (crossed(at(seeded, sSteps), at(seeded + 1, sSteps)))
        enqueue(seeded, sSteps - 1);
      if (seeded === tSteps - 1) seedLine(tSteps, tSteps - 1);
    }
    const cells = waiting.get(column);
    const j = cells?.pop();
    if (j !== undefined) {
      // Across each side of the grid cell the curve crosses.
      const i = column;
      const corners = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
      for (const corner of corners) reach(corner, corners[0].lift);
      if (crossed(corners[0], corners[1])) enqueue(i, j - 1);
      if (crossed(corners[2], corners[3])) enqueue(i, j + 1);
      if (crossed(corners[0], corners[2])) enqueue(i - 1, j);
      if (crossed(corners[1], corners[3])) enqueue(i + 1, j);
      continue;
    }
    column += 1;
    offerFresh();
    const line = near + ((far - near) * column) / tSteps;
    if (
      limit === tSteps &&
      hit.row !== null &&
      outOfReach([near, hit.entry], [line, far])
    ) {
      limit = column;
      seedLine(limit, limit - 1);
    }
  }
  offerFresh();
  return hit.row;
}

/**
 * A test of whether no cell reached from a trace point at t in `late` is drawn where the ray runs
 * over t in `early`. A trace point's base lies within its lift of the ray point (|n| = 1), the
 * point its cell is found at within that or within the ray point's overshoot of a pole (the
 * latitude is clamped), the cells of its `gridDisk(cell, 1)` within four circumradii of that,
 * and a drawn vertex within its lift of its cell. That bounds the drawing in map y; in x a cell's
 * longitudes spread as 1 / cos(latitude), without bound where it can hold a pole, and a cell
 * split at ±180° is drawn a map width away as well.
 */
function reachTest(
  ray: PickRay,
  mesh: MapFrameMesh,
): (early: [number, number], late: [number, number]) => boolean {
  const lift = mesh.maxLift + CPU_EXTRUSION_EPSILON_METRES;
  const footprint =
    4 *
    CIRCUMRADIUS_PER_EDGE *
    getHexagonEdgeLengthAvg(mesh.surface.grid.resolution, UNITS.m);
  const angle = footprint / MAP_RADIUS;
  /** The least and greatest of the ray's `axis` coordinate over t in [from, to]. */
  const range = (axis: number, [from, to]: [number, number]) => {
    const a = ray.origin[axis] + ray.direction[axis] * from;
    const b = ray.origin[axis] + ray.direction[axis] * to;
    return a < b ? [a, b] : [b, a];
  };
  const apart = (a: number[], b: number[], gap: number) =>
    a[1] < b[0] - gap || a[0] > b[1] + gap;
  return (early, late) => {
    const lateY = range(1, late);
    const beyond = Math.max(-lateY[0], lateY[1]);
    const pole = Math.max(0, beyond - MAP_WIDTH / 4);
    if (apart(range(1, early), lateY, 2 * lift + pole + footprint)) return true;
    const latitude = Math.min(Math.PI / 2, (beyond + lift) / MAP_RADIUS);
    if (latitude + angle >= Math.PI / 2) return false;
    const spread = MAP_RADIUS * Math.asin(Math.sin(angle) / Math.cos(latitude));
    const earlyX = range(0, early);
    const lateX = range(0, late);
    for (let copy = -2; copy <= 2; copy += 1) {
      const shift = copy * MAP_WIDTH;
      const shifted = [lateX[0] + shift, lateX[1] + shift];
      if (!apart(earlyX, shifted, 2 * lift + spread)) return false;
    }
    return true;
  };
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
