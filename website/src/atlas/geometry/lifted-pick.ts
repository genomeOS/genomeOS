/** A hover's pick of lifted data on the globe (fast-load spec 2026-10-07 §B.6.6; Atlas design
 * §11; owner decision 2026-11-14 on #483).
 *
 * A click reads the lifted surface's depth through a translucent depth pick. A hover makes no
 * GPU pick, so it finds the first drawn cell along the pointer's ray on the CPU: the cells near
 * the ray are rebuilt as drawn (`drawn-mesh.ts`), each vertex raised along its own geocentric
 * radial as the elevated shader raises it (`elevationNormal`).
 *
 * Candidates come from a walk along the ray through the shell a lifted cell can be drawn in,
 * from where the ray enters it (the WGS84 maximum radius plus the clearance and the tallest lift)
 * to the ground, which hides everything beyond: steps of a third of an average edge, each step's
 * cell (under the ray point's geocentric radial) bringing its `gridDisk(cell, 1)`, so every cell
 * the ray passes over is reached. A step changes the ray's height by at most its length, so a
 * cell reached only above its own reach by more than a step holds nothing on the ray.
 * Cesium-free.
 */

import { getHexagonEdgeLengthAvg, gridDisk, latLngToCell, UNITS } from 'h3-js';

import {
  CellCache,
  cellTriangles,
  firstRowAmong,
  type DrawnMesh,
  type Place,
} from './drawn-mesh';
import type { PickRay } from './pick-resolver';
import { CPU_EXTRUSION_EPSILON_METRES } from './surface-buffers';
import {
  geodeticToEcef,
  magnitude,
  scaleToGeocentricSurface,
  surfacePointToDegrees,
  type Vec3,
} from './wgs84';

/** WGS84's semi-axes, in metres. */
const EQUATORIAL_RADIUS = 6378137;
const POLAR_RADIUS = 6356752.314245179;

/** A vertex at (`lat`, `lon`, `height`), raised `lift` metres along its geocentric radial. */
const raise: Place = ([lat, lon], height, lift) => {
  const point: Vec3 = [0, 0, 0];
  geodeticToEcef(lon, lat, height, point);
  const scale = 1 + lift / magnitude(point);
  return [point[0] * scale, point[1] * scale, point[2] * scale];
};

/** Where a unit ray is inside the sphere of `radius` about the Earth's centre, or null. */
function sphereSpan(ray: PickRay, radius: number): [number, number] | null {
  const { direction, origin } = ray;
  const along = -(
    origin[0] * direction[0] +
    origin[1] * direction[1] +
    origin[2] * direction[2]
  );
  const discriminant =
    along * along - (magnitude(origin) ** 2 - radius * radius);
  if (discriminant < 0) return null;
  const half = Math.sqrt(discriminant);
  return along + half < 0 ? null : [along - half, along + half];
}

/** How far along a unit ray it first meets the WGS84 ellipsoid, or null if it never does. */
function groundEntry(ray: PickRay): number | null {
  const scales = [EQUATORIAL_RADIUS, EQUATORIAL_RADIUS, POLAR_RADIUS];
  const origin = ray.origin.map((axis, index) => axis / scales[index]);
  const direction = ray.direction.map((axis, index) => axis / scales[index]);
  const a = magnitude(direction) ** 2;
  const b =
    origin[0] * direction[0] +
    origin[1] * direction[1] +
    origin[2] * direction[2];
  const discriminant = b * b - a * (magnitude(origin) ** 2 - 1);
  if (discriminant < 0) return null;
  const entry = (-b - Math.sqrt(discriminant)) / a;
  return entry >= 0 ? entry : null;
}

/** The row of the first drawn cell `ray` (ECEF metres) meets on the globe, or null. */
export function firstLiftedRow(ray: PickRay, mesh: DrawnMesh): number | null {
  const length = magnitude(ray.direction);
  const unit: PickRay = {
    direction: ray.direction.map((axis) => axis / length) as Vec3,
    origin: ray.origin,
  };
  const shell = sphereSpan(
    unit,
    EQUATORIAL_RADIUS +
      mesh.clearance +
      mesh.maxLift +
      CPU_EXTRUSION_EPSILON_METRES,
  );
  if (!shell) return null;
  const ground = groundEntry(unit);
  const near = Math.max(0, shell[0]);
  const far = ground === null ? shell[1] : Math.min(shell[1], ground);
  if (far < near) return null;
  const resolution = mesh.surface.grid.resolution;
  const spacing = getHexagonEdgeLengthAvg(resolution, UNITS.m) / 3;
  /** Each cell with the least lift the walk reached it at. */
  const reached = new Map<string, number>();
  const disks = new Map<string, string[]>();
  const steps = Math.ceil((far - near) / spacing);
  for (let step = 0; step <= steps; step += 1) {
    const t = Math.min(far, near + step * spacing);
    const point = [0, 1, 2].map(
      (axis) => unit.origin[axis] + unit.direction[axis] * t,
    );
    const base = scaleToGeocentricSurface(point);
    const lift = magnitude(point) - magnitude(base) - mesh.clearance;
    const { lat, lon } = surfacePointToDegrees(base);
    const cell = latLngToCell(lat, lon, resolution);
    let disk = disks.get(cell);
    if (!disk) {
      disk = gridDisk(cell, 1);
      disks.set(cell, disk);
    }
    for (const near of disk) {
      const seen = reached.get(near);
      if (seen === undefined || lift < seen) reached.set(near, lift);
    }
  }
  const cache = new CellCache(mesh.surface);
  return firstRowAmong(
    unit,
    reached,
    spacing,
    mesh,
    cache,
    (cell, row) => cellTriangles(cell, row, mesh, cache, raise),
    ground ?? Number.POSITIVE_INFINITY,
  );
}
