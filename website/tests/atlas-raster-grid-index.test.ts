import { cellToVertexes, gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  crossesAntimeridian,
  h3BoundaryDegrees,
} from '../src/atlas/geometry/polygon-parts';
import type { DegreeRectangle } from '../src/atlas/geometry/raster/types';
import { cellLanes, type GridTopology } from '../src/atlas/geometry/topology';
import {
  KENYA_CELLS,
  poleCells,
  rasterInputFor,
  seamCells,
  type TestCell,
} from './helpers/raster-fixtures';
import { sortedU64 } from './helpers/mesh-input';

/** A res-3 pentagon (at an icosahedron vertex) and its ring: class III cells whose boundaries
 * carry distortion vertices that the topology's corners do not hold. */
const CLASS_III_CELLS: TestCell[] = sortedU64(
  gridDisk('83d600fffffffff', 1),
).map((h3): TestCell => ({ h3, support: 'observed', value: 0.5 }));

const unwrap = (lon: number, near: number) =>
  lon - 360 * Math.round((lon - near) / 360);

/** Brute force over every row, no buckets: the row's corner box as the design states it (corners
 * unwrapped near the centre, padded by 10% of the box's extent; a pole-holding row spans every
 * longitude to the pole), tested against `rect` and its ±360° copies. */
function rowsWhoseCornersOverlap(
  topology: GridTopology,
  rect: DegreeRectangle,
): number[] {
  const rows: number[] = [];
  for (let row = 0; row < topology.n; row += 1) {
    const lons: number[] = [];
    const lats: number[] = [];
    for (
      let k = topology.cornerOffsets[row];
      k < topology.cornerOffsets[row + 1];
      k += 1
    ) {
      const id = topology.cornerIds[k];
      lons.push(unwrap(topology.vertexLon[id], topology.centreLon[row]));
      lats.push(topology.vertexLat[id]);
    }
    let [west, east] = [Math.min(...lons), Math.max(...lons)];
    let [south, north] = [Math.min(...lats), Math.max(...lats)];
    if (east - west > 180) {
      [west, east] = [-180, 180];
      if (topology.centreLat[row] > 0) north = 90;
      else south = -90;
    }
    const padLon = 0.1 * (east - west);
    const padLat = 0.1 * (north - south);
    if (east - west < 360) [west, east] = [west - padLon, east + padLon];
    [south, north] = [south - padLat, north + padLat];
    const overlaps = [-360, 0, 360].some(
      (shift) =>
        west + shift <= rect.east &&
        east + shift >= rect.west &&
        south <= rect.north &&
        north >= rect.south,
    );
    if (overlaps) rows.push(row);
  }
  return rows;
}

/** A rectangle of ±1e-9° around a point. */
const around = (lon: number, lat: number): DegreeRectangle => ({
  east: lon + 1e-9,
  north: lat + 1e-9,
  south: lat - 1e-9,
  west: lon - 1e-9,
});

describe('raster grid index (#483)', () => {
  it('returns each row overlapping a rectangle once, in ascending order', () => {
    const { index, topology } = rasterInputFor(KENYA_CELLS);
    const rect = { east: 37.5, north: -1, south: -2.5, west: 36 };
    const rows = index.rowsIn(rect);
    expect(rows).toEqual([...new Set(rows)].sort((a, b) => a - b));
    expect(rows).toEqual(rowsWhoseCornersOverlap(topology, rect)); // brute force over every row
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(KENYA_CELLS.length);
  });

  it('holds every boundary point of every cell, distortion vertices included', () => {
    const distorted = CLASS_III_CELLS.filter(
      ({ h3 }) => h3BoundaryDegrees(h3).length > cellToVertexes(h3).length,
    );
    expect(distorted.length).toBeGreaterThan(0);
    for (const cells of [KENYA_CELLS, CLASS_III_CELLS]) {
      const { grid, index } = rasterInputFor(cells);
      for (let row = 0; row < grid.n; row += 1)
        for (const [lon, lat] of h3BoundaryDegrees(cellLanes(grid, row)))
          expect(index.rowsIn(around(lon, lat))).toContain(row);
    }
  });

  it('finds a cell that crosses ±180° from tiles on both sides (its ±360° copy)', () => {
    const seam = seamCells().find(({ h3 }) => crossesAntimeridian(h3))!;
    const { index } = rasterInputFor([seam]);
    expect(
      index.rowsIn({ east: 180, north: 1, south: -1, west: 179.5 }),
    ).toEqual([0]);
    expect(
      index.rowsIn({ east: -179.5, north: 1, south: -1, west: -180 }),
    ).toEqual([0]);
    expect(index.bounds(() => true)).toMatchObject({ east: 180, west: -180 });
  });

  it('wraps a rectangle grown past ±180° onto the far side', () => {
    const cells = seamCells();
    const { index, topology } = rasterInputFor(cells);
    const wholly = (lo: number, hi: number) =>
      cells.findIndex(({ h3 }) =>
        h3BoundaryDegrees(h3).every(([lon]) => lon > lo && lon < hi),
      );
    const westOfSeam = wholly(179, 179.9);
    const eastOfSeam = wholly(-179.98, -179);
    expect([westOfSeam, eastOfSeam]).not.toContain(-1);
    const pastWest = { east: -179.99, north: 0.6, south: -0.2, west: -180.3 };
    const pastEast = { east: 180.3, north: 0.6, south: -0.2, west: 179.99 };
    expect(index.rowsIn(pastWest)).toContain(westOfSeam);
    expect(index.rowsIn({ ...pastWest, west: -180 })).not.toContain(westOfSeam);
    expect(index.rowsIn(pastEast)).toContain(eastOfSeam);
    expect(index.rowsIn({ ...pastEast, east: 180 })).not.toContain(eastOfSeam);
    for (const rect of [pastWest, pastEast])
      expect(index.rowsIn(rect)).toEqual(
        rowsWhoseCornersOverlap(topology, rect),
      );
  });

  it('reaches the pole for a pole cell', () => {
    const { index } = rasterInputFor([
      { h3: latLngToCell(90, 0, 4), support: 'observed', value: 0.5 },
    ]);
    expect(
      index.rowsIn({ east: 180, north: 90, south: 89.99, west: -180 }),
    ).toEqual([0]);
    expect(index.bounds(() => true)).toMatchObject({
      east: 180,
      north: 90,
      west: -180,
    });
  });

  it('finds every pole-ring cell at its own boundary points', () => {
    const cells = poleCells();
    const { grid, index, topology } = rasterInputFor(cells);
    for (let row = 0; row < grid.n; row += 1)
      for (const [lon, lat] of h3BoundaryDegrees(cellLanes(grid, row)))
        expect(index.rowsIn(around(lon, lat))).toContain(row);
    const cap = { east: 180, north: 90, south: 89.5, west: -180 };
    expect(index.rowsIn(cap)).toEqual(rowsWhoseCornersOverlap(topology, cap));
  });

  it('bounds the drawn rows only, and nothing when none is drawn', () => {
    const { grid, index } = rasterInputFor(KENYA_CELLS);
    const b = index.bounds((row) => row < 10)!;
    for (let row = 0; row < 10; row += 1)
      for (const [lon, lat] of h3BoundaryDegrees(cellLanes(grid, row))) {
        expect(lon).toBeGreaterThanOrEqual(b.west);
        expect(lon).toBeLessThanOrEqual(b.east);
        expect(lat).toBeGreaterThanOrEqual(b.south);
        expect(lat).toBeLessThanOrEqual(b.north);
      }
    expect(index.bounds(() => false)).toBeNull();
    const all = index.bounds(() => true)!;
    expect(all.west).toBeLessThanOrEqual(b.west);
    expect(all.east).toBeGreaterThanOrEqual(b.east);
    expect(all.south).toBeLessThanOrEqual(b.south);
    expect(all.north).toBeGreaterThanOrEqual(b.north);
  });

  it('reuses the given array, and finds nothing where no cell lies', () => {
    const { index } = rasterInputFor(KENYA_CELLS);
    const rect = { east: 37.5, north: -1, south: -2.5, west: 36 };
    const out = [99, 98];
    expect(index.rowsIn(rect, out)).toBe(out);
    expect(out).toEqual(index.rowsIn(rect));
    expect(
      index.rowsIn({ east: 10, north: 50, south: 40, west: 0 }, out),
    ).toEqual([]);
  });
});
