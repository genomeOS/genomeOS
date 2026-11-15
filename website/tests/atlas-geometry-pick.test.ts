import {
  cellToBoundary,
  cellToLatLng,
  cellToVertexes,
  cellsToDirectedEdge,
  directedEdgeToBoundary,
  gridDisk,
  latLngToCell,
  vertexToLatLng,
} from 'h3-js';
import { describe, expect, it, vi } from 'vitest';

import type { DrawnMesh } from '../src/atlas/geometry/drawn-mesh';
import { firstLiftedRow } from '../src/atlas/geometry/lifted-pick';
import { firstDrawnRowAlong } from '../src/atlas/geometry/map-frame-pick';
import {
  resolveSurfaceRow,
  type PickRay,
} from '../src/atlas/geometry/pick-resolver';
import { buildSupportChunk } from '../src/atlas/geometry/support-buffers';
import { isSupportedCode } from '../src/atlas/geometry/support-codes';
import {
  buildSurfaceChunk,
  SURFACE_CLEARANCE_METRES,
  type MeshInput,
  type SurfaceChunkBuffers,
} from '../src/atlas/geometry/surface-buffers';
import { geodeticToEcef, magnitude } from '../src/atlas/geometry/wgs84';
import { renderAt, type SurfaceArtifact } from '../src/atlas/surface-columns';
import type { SurfaceGeometry } from '../src/atlas/url-state';
import { heightFor, MAX_HEIGHT_METRES } from '../src/atlas/visual-encoding';
import {
  meshInputFor,
  sortedU64,
  wholeGridChunk,
  type TestCell,
} from './helpers/mesh-input';

// h3-js stays real everywhere. The spy only lets the tie-break test give
// several neighbours one centre: no real grid has an exact distance tie. The
// count (not a spy, which would keep millions of calls) lets the hover's work
// test read how many points of its trace were placed in a cell.
const h3Calls = vi.hoisted(() => ({ latLngToCell: 0 }));
vi.mock('h3-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3-js')>();
  return {
    ...actual,
    cellToLatLng: vi.fn(actual.cellToLatLng),
    latLngToCell: (...args: Parameters<typeof actual.latLngToCell>) => {
      h3Calls.latLngToCell += 1;
      return actual.latLngToCell(...args);
    },
  };
});

const RESOLUTION = 3;
const CENTRE = '83754efffffffff';
/** `latLngToCell(45, 10, 3)`. At 45°N the geocentric radial and the geodetic
 * normal differ by about 0.19°, so a geodetic projection of a lifted point can
 * land in the next cell; at CENTRE (0.4°N) it never does. */
const MID_LATITUDE = '831ea6fffffffff';
const DISK = sortedU64(gridDisk(CENTRE, 1));
const TALL = 0.9;
const SHORT = 0.2;
const GEOMETRIES = ['triangles', 'honmoon', 'hexagons'] as const;

/** `[lat, lon]` in degrees, the order h3-js uses. */
type Degrees = [number, number];
type Cartesian = [number, number, number];

function setup(
  geometry: SurfaceGeometry,
  centre = CENTRE,
  cellOf: (h3: string) => Omit<TestCell, 'h3'> = (h3) => ({
    support: 'interpolated',
    value: h3 === centre ? TALL : SHORT,
  }),
  radius = 1,
): {
  disk: string[];
  input: MeshInput;
  surface: SurfaceArtifact;
  buffers: SurfaceChunkBuffers;
  heights: (row: number) => number;
} {
  const disk = sortedU64(gridDisk(centre, radius));
  const input = meshInputFor(
    disk.map((h3) => ({ h3, ...cellOf(h3) })),
    { geometry },
  );
  const surface = {
    artifact: {
      metric_domains: { post_mean: [0, 1], post_sd: [0, 1] },
      resolution: input.grid.resolution,
    },
    artifactKey: 'fixture:v1:d1',
    detail: null,
    grid: input.grid,
    support: input.support,
    values: { post_mean: input.values, post_sd: input.values },
  } as unknown as SurfaceArtifact;
  return {
    buffers: buildSurfaceChunk(input, wholeGridChunk(input)),
    disk,
    // The scene's callback (contract): render tier, exaggeration 1, 0 masked.
    heights: (row) => {
      const cell = renderAt(surface, row);
      return heightFor(cell.support, cell.post_mean, [0, 1], 1);
    },
    input,
    surface,
  };
}

function displaced(
  buffers: SurfaceChunkBuffers,
  vertex: number,
  factor: number,
): number[] {
  return [0, 1, 2].map(
    (axis) =>
      buffers.positions[vertex * 3 + axis] +
      buffers.elevationNormals[vertex * 3 + axis] *
        buffers.heights[vertex] *
        factor,
  );
}

function blend(
  points: readonly number[][],
  weights: readonly number[],
): Cartesian {
  return [0, 1, 2].map((axis) =>
    points.reduce(
      (total, point, index) => total + point[axis] * weights[index],
      0,
    ),
  ) as Cartesian;
}

/** The point `altitude` metres above the surface clearance over `ground`,
 * along the geocentric radial: the resolver's hit altitude is `altitude`. */
function lifted([lat, lon]: Degrees, altitude: number): Cartesian {
  const ground = [0, 0, 0];
  geodeticToEcef(lon, lat, 0, ground);
  const scale = 1 + (SURFACE_CLEARANCE_METRES + altitude) / magnitude(ground);
  return ground.map((axis) => axis * scale) as Cartesian;
}

function chord(from: Degrees, to: Degrees): number {
  const [a, b] = [from, to].map(([lat, lon]) => {
    const point = [0, 0, 0];
    geodeticToEcef(lon, lat, 0, point);
    return point;
  });
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** A ground point inside `cell`, 3% of the way short of its edge with
 * `other` (asserted inside `cell`, so each case exercises the branch named). */
function besideEdge(cell: string, other: string): Degrees {
  const [[firstLat, firstLon], [secondLat, secondLon]] = directedEdgeToBoundary(
    cellsToDirectedEdge(cell, other),
  );
  const [lat, lon] = cellToLatLng(cell);
  const point: Degrees = [
    lat + ((firstLat + secondLat) / 2 - lat) * 0.97,
    lon + ((firstLon + secondLon) / 2 - lon) * 0.97,
  ];
  expect(latLngToCell(point[0], point[1], RESOLUTION), 'precondition').toBe(
    cell,
  );
  return point;
}

/** Geodetic `[lat, lon]` of any ECEF point (Bowring iteration): the projection
 * Cesium's `cartesianToCartographic` makes. A test oracle only, showing that
 * the 45°N fixture separates the geodetic and the geocentric projection. */
function geodeticDegrees([x, y, z]: readonly number[]): Degrees {
  const a = 6378137;
  const b = 6356752.3142451793;
  const e2 = 1 - (b * b) / (a * a);
  const radius = Math.hypot(x, y);
  let lat = Math.atan2(z, radius * (1 - e2));
  for (let step = 0; step < 10; step += 1) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const height = radius / Math.cos(lat) - n;
    lat = Math.atan2(z, radius * (1 - (e2 * n) / (n + height)));
  }
  return [(lat * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI];
}

function extrudedPick(
  surface: SurfaceArtifact,
  heights: (row: number) => number,
  factor: number,
): (cartesian: Cartesian) => number | null {
  return (cartesian) =>
    resolveSurfaceRow(
      {
        cartesian,
        clearance: SURFACE_CLEARANCE_METRES,
        ellipsoidHit: null,
        factor,
        geometry: 'extruded',
      },
      surface,
      heights,
    );
}

/** Points blended from every exaggeration-5 fan triangle of the disk around
 * `centre` resolve to their own row. Returns how many of them a geodetic
 * projection would have put in another cell. */
function expectNearEdgePicks(
  geometry: (typeof GEOMETRIES)[number],
  centre: string,
): number {
  const { disk, surface, buffers, heights, input } = setup(geometry, centre);
  let triangle = 0;
  let geodeticMisses = 0;
  disk.forEach((h3, row) => {
    const corners =
      input.topology.cornerOffsets[row + 1] - input.topology.cornerOffsets[row];
    for (let corner = 0; corner < corners; corner += 1, triangle += 1) {
      const vertices = [0, 1, 2].map((offset) =>
        displaced(buffers, buffers.indices[triangle * 3 + offset], 5),
      );
      for (const weights of [
        [0.02, 0.49, 0.49],
        [0.005, 0.4975, 0.4975],
        [0.02, 0.9, 0.08],
        [0.34, 0.33, 0.33],
      ]) {
        const cartesian = blend(vertices, weights);
        expect(
          resolveSurfaceRow(
            {
              cartesian,
              clearance: SURFACE_CLEARANCE_METRES,
              ellipsoidHit: null,
              factor: 5,
              geometry,
            },
            surface,
            heights,
          ),
          `${h3} triangle ${corner} ${weights}`,
        ).toBe(row);
        const [lat, lon] = geodeticDegrees(cartesian);
        if (latLngToCell(lat, lon, RESOLUTION) !== h3) geodeticMisses += 1;
      }
    }
  });
  return geodeticMisses;
}

describe('surface pick resolution (fast-load §B.6.6)', () => {
  it('reads the ellipsoid hit at elevation factor 0', () => {
    const { surface, heights } = setup('triangles');
    DISK.forEach((h3, row) => {
      const [lat, lon] = cellToLatLng(h3);
      const pick = (hit: { lat: number; lon: number } | null) =>
        resolveSurfaceRow(
          {
            cartesian: null,
            clearance: SURFACE_CLEARANCE_METRES,
            ellipsoidHit: hit,
            factor: 0,
            geometry: 'triangles',
          },
          surface,
          heights,
        );
      expect(pick({ lat, lon })).toBe(row);
      for (const [vertexLat, vertexLon] of cellToBoundary(h3))
        expect(
          pick({
            lat: lat + (vertexLat - lat) * 0.99,
            lon: lon + (vertexLon - lon) * 0.99,
          }),
        ).toBe(row);
      expect(pick(null)).toBeNull();
    });
    expect(
      resolveSurfaceRow(
        {
          cartesian: null,
          clearance: SURFACE_CLEARANCE_METRES,
          ellipsoidHit: { lat: -60, lon: -30 },
          factor: 0,
          geometry: 'triangles',
        },
        surface,
        heights,
      ),
    ).toBeNull();
  });

  it.each(['triangles', 'hexagons', 'extruded'] as const)(
    'returns null without a picked position or off the grid at exaggeration 5 (%s)',
    (geometry) => {
      const { surface } = setup(geometry);
      const [lat, lon] = cellToLatLng(CENTRE);
      // Neither case reaches the heights; only `extruded` ever reads them.
      const unread = (): number => {
        throw new Error('heights read');
      };
      const pick = (
        cartesian: Cartesian | null,
        heights: (row: number) => number = unread,
      ) =>
        resolveSurfaceRow(
          {
            cartesian,
            clearance: SURFACE_CLEARANCE_METRES,
            // Ignored above factor 0, even when it lies on the grid.
            ellipsoidHit: { lat, lon },
            factor: 5,
            geometry,
          },
          surface,
          heights,
        );
      expect(pick(null)).toBeNull();
      expect(pick(lifted([-60, -30], 1_000))).toBeNull();
      if (geometry !== 'extruded')
        expect(pick(lifted([lat, lon], 500_000))).toBe(DISK.indexOf(CENTRE));
    },
  );

  it.each(GEOMETRIES)(
    'undoes the radial lift near cell edges at exaggeration 5 (%s)',
    (geometry) => {
      expectNearEdgePicks(geometry, CENTRE);
    },
  );

  it.each(GEOMETRIES)(
    'projects along the geocentric radial, not the geodetic normal, at 45°N (%s)',
    (geometry) => {
      expect(
        expectNearEdgePicks(geometry, MID_LATITUDE),
        'picks that a geodetic projection puts in another cell',
      ).toBeGreaterThan(0);
    },
  );

  it.each([1, 5])(
    'gives extruded wall hits to the taller cell at exaggeration %d',
    (factor) => {
      const { surface, buffers, heights, input } = setup('extruded');
      const centreRow = DISK.indexOf(CENTRE);
      const { cornerOffsets } = input.topology;
      let base = 0;
      for (let row = 0; row < centreRow; row += 1) {
        const count = cornerOffsets[row + 1] - cornerOffsets[row];
        base += 1 + count * 5;
      }
      const corners = cellToVertexes(CENTRE);
      const resolve = extrudedPick(surface, heights, factor);
      const tallHeight = Math.fround(heights(centreRow));
      // Precondition on Task 44's extruded layout: the centre cell's top
      // centre vertex sits at `base`.
      expect(buffers.heights[base], 'top centre vertex').toBe(tallHeight);
      let walls = 0;
      for (const neighbour of DISK.filter((cell) => cell !== CENTRE)) {
        const neighbourRow = DISK.indexOf(neighbour);
        const shared = cellToVertexes(neighbour);
        const corner = corners.findIndex(
          (vertex, index) =>
            shared.includes(vertex) &&
            shared.includes(corners[(index + 1) % corners.length]),
        );
        expect(corner, neighbour).toBeGreaterThanOrEqual(0);
        const wall = base + 1 + corners.length + corner * 4;
        // Preconditions: the four vertices at `wall` are this shared edge's
        // quad (bottom, bottom, top, top), with the bottoms at its two corners.
        expect(
          [0, 1, 2, 3].map((offset) => buffers.heights[wall + offset]),
          `${neighbour} wall heights`,
        ).toEqual([0, 0, tallHeight, tallHeight]);
        [corners[corner], corners[(corner + 1) % corners.length]].forEach(
          (vertex, offset) => {
            const [vertexLat, vertexLon] = vertexToLatLng(vertex);
            const foot = [0, 0, 0];
            geodeticToEcef(
              vertexLon,
              vertexLat,
              SURFACE_CLEARANCE_METRES,
              foot,
            );
            const gap = Math.hypot(
              ...[0, 1, 2].map(
                (axis) =>
                  buffers.positions[(wall + offset) * 3 + axis] - foot[axis],
              ),
            );
            expect(gap, `${neighbour} wall foot ${offset}`).toBeLessThan(1e-3);
          },
        );
        const [bottomFirst, bottomSecond, topFirst, topSecond] = [
          0, 1, 2, 3,
        ].map((offset) => displaced(buffers, wall + offset, factor));
        const shortTop = heights(neighbourRow) * factor;
        const tallTop = heights(centreRow) * factor;
        for (const along of [0.3, 0.5, 0.7])
          for (const up of [0.25, 0.5, 0.9]) {
            const altitude = shortTop + 10 + (tallTop - shortTop - 20) * up;
            const fraction = altitude / (tallTop + 1);
            const point = blend(
              [bottomFirst, bottomSecond, topFirst, topSecond],
              [
                (1 - along) * (1 - fraction),
                along * (1 - fraction),
                (1 - along) * fraction,
                along * fraction,
              ],
            );
            expect(resolve(point), `${neighbour} wall ${along} ${up}`).toBe(
              centreRow,
            );
          }
        const [lat, lon] = cellToLatLng(neighbour);
        const [vertexLat, vertexLon] = vertexToLatLng(corners[corner]);
        const nearEdge = [0, 0, 0];
        geodeticToEcef(
          lon + (vertexLon - lon) * 0.97,
          lat + (vertexLat - lat) * 0.97,
          SURFACE_CLEARANCE_METRES + 1 + shortTop,
          nearEdge,
        );
        expect(resolve(nearEdge as Cartesian), `${neighbour} top`).toBe(
          neighbourRow,
        );
        walls += 1;
      }
      expect(walls).toBe(6);
    },
  );

  it.each([1, 5])(
    'gives a wall hit to the nearest neighbour tall enough, not the tallest or the first, at exaggeration %d',
    (factor) => {
      // The centre is the shortest cell and the ring rises with its row, so
      // for five of the six walls the tallest neighbour, and the first that
      // gridDisk visits, are not the nearest one.
      const ring = DISK.filter((cell) => cell !== CENTRE);
      const { surface, heights } = setup('extruded', CENTRE, (h3) => ({
        support: 'interpolated',
        value: h3 === CENTRE ? 0.1 : 0.4 + 0.1 * ring.indexOf(h3),
      }));
      const resolve = extrudedPick(surface, heights, factor);
      const lowestRingTop = Math.min(
        ...ring.map((cell) => heights(DISK.indexOf(cell))),
      );
      // Above the centre's top, below every ring top: every neighbour qualifies.
      const altitude =
        ((heights(DISK.indexOf(CENTRE)) + lowestRingTop) / 2) * factor;
      expect(
        ring.map((neighbour) =>
          resolve(lifted(besideEdge(CENTRE, neighbour), altitude)),
        ),
      ).toEqual(ring.map((neighbour) => DISK.indexOf(neighbour)));
    },
  );

  it.each([1, 5])(
    'skips masked and short neighbours and falls back to the projected row at exaggeration %d',
    (factor) => {
      const ring = DISK.filter((cell) => cell !== CENTRE);
      const masked = ring[0];
      const short = ring.find(
        (cell) => cell !== masked && gridDisk(masked, 1).includes(cell),
      );
      if (short === undefined)
        throw new Error('precondition: a ring cell borders the masked one');
      const { surface, heights } = setup('extruded', CENTRE, (h3) => ({
        support: h3 === masked ? 'unknown' : 'interpolated',
        value: h3 === CENTRE ? TALL : SHORT,
      }));
      const resolve = extrudedPick(surface, heights, factor);
      const [centreRow, maskedRow, shortRow] = [CENTRE, masked, short].map(
        (cell) => DISK.indexOf(cell),
      );
      expect(heights(maskedRow), 'masked rows have no height').toBe(0);
      const shortTop = heights(shortRow) * factor;
      const tallTop = heights(centreRow) * factor;

      // The masked cell's own flat support surface resolves to it.
      expect(resolve(lifted(cellToLatLng(masked), 0))).toBe(maskedRow);
      expect(resolve(lifted(besideEdge(masked, CENTRE), 0))).toBe(maskedRow);
      // The tall centre's wall standing over the masked cell.
      expect(resolve(lifted(besideEdge(masked, CENTRE), tallTop / 2))).toBe(
        centreRow,
      );

      // Over the short cell beside the masked one, above the short top: the
      // masked cell is the nearest neighbour but too low, as is the other
      // short ring cell, so the tall centre wins.
      const overShort = besideEdge(short, masked);
      expect(
        chord(overShort, cellToLatLng(masked)),
        'precondition: the masked cell is the nearest neighbour',
      ).toBeLessThan(chord(overShort, cellToLatLng(CENTRE)));
      expect(resolve(lifted(overShort, (shortTop + tallTop) / 2))).toBe(
        centreRow,
      );
      // Above every top no neighbour qualifies and the projected row stands.
      expect(resolve(lifted(overShort, tallTop + 10_000))).toBe(shortRow);
    },
  );

  it.each([1, 5])(
    'gives boundary wall hits that project off the grid to the grid cell at exaggeration %d',
    (factor) => {
      const { surface, heights } = setup('extruded');
      const resolve = extrudedPick(surface, heights, factor);
      const tallTop = heights(DISK.indexOf(CENTRE)) * factor;
      let walls = 0;
      for (const cell of DISK.filter((h3) => h3 !== CENTRE)) {
        const row = DISK.indexOf(cell);
        for (const outside of gridDisk(cell, 1)) {
          if (DISK.includes(outside)) continue;
          // Just across the grid cell's outer wall, inside the off-grid cell.
          const ground = besideEdge(outside, cell);
          expect(
            resolve(lifted(ground, (heights(row) * factor) / 2)),
            `${cell} outer wall toward ${outside}`,
          ).toBe(row);
          expect(
            resolve(lifted(ground, tallTop + 10_000)),
            `${outside} above every top`,
          ).toBeNull();
          walls += 1;
        }
      }
      expect(walls).toBe(18);
    },
  );

  it('breaks an exact centre-distance tie toward the lower row', async () => {
    const { cellToLatLng: realCellToLatLng } =
      await vi.importActual<typeof import('h3-js')>('h3-js');
    const tall = [DISK[2], DISK[4], DISK[6]];
    const { surface, heights } = setup('extruded', CENTRE, (h3) => ({
      support: 'interpolated',
      value: tall.includes(h3) ? TALL : h3 === CENTRE ? 0.1 : SHORT,
    }));
    const visited = gridDisk(CENTRE, 1)
      .filter((cell) => tall.includes(cell))
      .map((cell) => DISK.indexOf(cell));
    const lowest = Math.min(...visited);
    // Preconditions: the centre is not tied, and the lowest tied row is
    // neither the first nor the last that gridDisk visits, so neither
    // "first wins" nor "last wins" passes.
    expect(tall).not.toContain(CENTRE);
    expect(visited[0]).not.toBe(lowest);
    expect(visited.at(-1)).not.toBe(lowest);
    // Above the centre and the short ring, below the tall ring.
    const point = lifted(realCellToLatLng(CENTRE), 100_000);
    const spy = vi.mocked(cellToLatLng);
    spy.mockImplementation(() => [10, 20]);
    try {
      expect(extrudedPick(surface, heights, 1)(point)).toBe(lowest);
    } finally {
      spy.mockImplementation(realCellToLatLng);
    }
  });
});

/** A ray from `from` metres above `ground` straight down its geocentric radial. */
function nadirRay(ground: Degrees, from: number): PickRay {
  const origin = lifted(ground, from);
  const below = lifted(ground, 0);
  const length = Math.hypot(
    ...[0, 1, 2].map((axis) => below[axis] - origin[axis]),
  );
  return {
    direction: [0, 1, 2].map(
      (axis) => (below[axis] - origin[axis]) / length,
    ) as Cartesian,
    origin,
  };
}

describe('extruded picks along the pick ray (fast-load §B.6.6 prism test)', () => {
  function resolverFor(
    surface: SurfaceArtifact,
    heights: (row: number) => number,
    factor: number,
  ) {
    return (cartesian: Cartesian, ray: PickRay | null) =>
      resolveSurfaceRow(
        {
          cartesian,
          clearance: SURFACE_CLEARANCE_METRES,
          ellipsoidHit: null,
          factor,
          geometry: 'extruded',
          ray,
        },
        surface,
        heights,
      );
  }

  it.each([1, 5])(
    'keeps a top-face hit on a short or masked cell whose depth reads above the slack at exaggeration %d',
    (factor) => {
      const ring = DISK.filter((cell) => cell !== CENTRE);
      const [masked, , , short] = ring;
      const { surface, heights } = setup('extruded', CENTRE, (h3) => ({
        support: h3 === masked ? 'unknown' : 'interpolated',
        value: h3 === CENTRE ? TALL : SHORT,
      }));
      const resolve = resolverFor(surface, heights, factor);
      for (const cell of [short, masked]) {
        const row = DISK.indexOf(cell);
        const ground = besideEdge(cell, CENTRE);
        // Depth-buffer noise lifts the hit 2 km over the top along the view
        // ray (Task 69's probe measured up to about 16 km in a world view).
        const noisy = lifted(ground, heights(row) * factor + 2_000);
        expect(resolve(noisy, null), `${cell}: the altitude test alone`).toBe(
          DISK.indexOf(CENTRE),
        );
        expect(resolve(noisy, nadirRay(ground, 3_000_000)), cell).toBe(row);
      }
    },
  );

  it.each([1, 5])(
    'gives an oblique ray that meets the tall wall first to the tall cell at exaggeration %d',
    (factor) => {
      const { surface, heights } = setup('extruded');
      const resolve = resolverFor(surface, heights, factor);
      const centreRow = DISK.indexOf(CENTRE);
      const tallTop = heights(centreRow) * factor;
      for (const neighbour of DISK.filter((cell) => cell !== CENTRE)) {
        const shortTop = heights(DISK.indexOf(neighbour)) * factor;
        const [first, second] = directedEdgeToBoundary(
          cellsToDirectedEdge(neighbour, CENTRE),
        ).map(([lat, lon]) => {
          const point = [0, 0, 0];
          geodeticToEcef(lon, lat, SURFACE_CLEARANCE_METRES, point);
          return point;
        });
        // Halfway up the shared wall, which lies in the plane through the
        // Earth's centre and the edge's two corners.
        const middle = [0, 1, 2].map(
          (axis) => (first[axis] + second[axis]) / 2,
        );
        const lift = 1 + (shortTop + tallTop) / 2;
        const wall = middle.map(
          (axis) => axis * (1 + lift / magnitude(middle)),
        ) as Cartesian;
        const origin = lifted(cellToLatLng(neighbour), tallTop + 400_000);
        const length = Math.hypot(
          ...[0, 1, 2].map((axis) => wall[axis] - origin[axis]),
        );
        const direction = [0, 1, 2].map(
          (axis) => (wall[axis] - origin[axis]) / length,
        ) as Cartesian;
        // The depth hit lands 300 m short of the wall, over the short cell.
        const noisy = [0, 1, 2].map(
          (axis) => wall[axis] - direction[axis] * 300,
        ) as Cartesian;
        expect(resolve(noisy, { direction, origin }), neighbour).toBe(
          centreRow,
        );
      }
    },
  );

  it.each([1, 5])(
    'agrees with rays cast at the extruded mesh itself at exaggeration %d',
    (factor) => {
      // Rising heights so most rays meet a wall before or instead of a top.
      const ring = DISK.filter((cell) => cell !== CENTRE);
      const { surface, buffers, heights, input } = setup(
        'extruded',
        CENTRE,
        (h3) => ({
          support: 'interpolated',
          value: h3 === CENTRE ? 0.95 : 0.1 + 0.12 * ring.indexOf(h3),
        }),
      );
      const resolve = resolverFor(surface, heights, factor);
      // Each row owns its fan triangles and then two triangles per wall.
      const owners: number[] = [];
      DISK.forEach((_, row) => {
        const corners =
          input.topology.cornerOffsets[row + 1] -
          input.topology.cornerOffsets[row];
        for (let index = 0; index < corners * 3; index += 1) owners.push(row);
      });
      expect(owners).toHaveLength(buffers.indices.length / 3);
      const triangles = owners.map((_, triangle) =>
        [0, 1, 2].map((offset) =>
          displaced(buffers, buffers.indices[triangle * 3 + offset], factor),
        ),
      );
      const [centreLat, centreLon] = cellToLatLng(CENTRE);
      const tallest = Math.max(...DISK.map((_, row) => heights(row))) * factor;
      let checked = 0;
      for (const [northing, easting] of [
        [1.4, 0],
        [-1.4, 0.3],
        [0.2, 1.5],
        [-0.5, -1.4],
      ]) {
        const origin = lifted(
          [centreLat + northing, centreLon + easting],
          tallest + 150_000,
        );
        for (let step = 0; step < 49; step += 1) {
          const target = lifted(
            [
              centreLat + ((step % 7) - 3) * 0.17 + 0.013,
              centreLon + (Math.floor(step / 7) - 3) * 0.17 + 0.007,
            ],
            0,
          );
          const length = Math.hypot(
            ...[0, 1, 2].map((axis) => target[axis] - origin[axis]),
          );
          const direction = [0, 1, 2].map(
            (axis) => (target[axis] - origin[axis]) / length,
          ) as Cartesian;
          // The first mesh triangle along the ray (Moller-Trumbore).
          let nearest = Number.POSITIVE_INFINITY;
          let owner: number | null = null;
          triangles.forEach(([a, b, c], triangle) => {
            const e1 = [0, 1, 2].map((axis) => b[axis] - a[axis]);
            const e2 = [0, 1, 2].map((axis) => c[axis] - a[axis]);
            const p = [
              direction[1] * e2[2] - direction[2] * e2[1],
              direction[2] * e2[0] - direction[0] * e2[2],
              direction[0] * e2[1] - direction[1] * e2[0],
            ];
            const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
            if (Math.abs(det) < 1e-9) return;
            const s = [0, 1, 2].map((axis) => origin[axis] - a[axis]);
            const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
            const q = [
              s[1] * e1[2] - s[2] * e1[1],
              s[2] * e1[0] - s[0] * e1[2],
              s[0] * e1[1] - s[1] * e1[0],
            ];
            const v =
              (direction[0] * q[0] +
                direction[1] * q[1] +
                direction[2] * q[2]) /
              det;
            const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
            // Keep clear of shared edges, where either owner is right.
            if (u < 1e-4 || v < 1e-4 || u + v > 1 - 1e-4 || t <= 0) return;
            if (t < nearest) {
              nearest = t;
              owner = owners[triangle];
            }
          });
          if (owner === null) continue;
          for (const noise of [-2_000, 0, 2_000]) {
            const cartesian = [0, 1, 2].map(
              (axis) => origin[axis] + direction[axis] * (nearest + noise),
            ) as Cartesian;
            expect(
              resolve(cartesian, { direction, origin }),
              `${northing},${easting} step ${step} noise ${noise}`,
            ).toBe(owner);
          }
          checked += 1;
        }
      }
      expect(checked, 'rays that meet the mesh').toBeGreaterThan(80);
    },
  );

  it('falls back to the altitude test when the ray enters no candidate prism', () => {
    const { surface, heights } = setup('extruded');
    const resolve = resolverFor(surface, heights, 5);
    const short = DISK.find((cell) => cell !== CENTRE)!;
    const ground = besideEdge(short, CENTRE);
    const noisy = lifted(ground, heights(DISK.indexOf(short)) * 5 + 2_000);
    const down = nadirRay(ground, 3_000_000);
    const away: PickRay = {
      direction: down.direction.map((axis) => -axis) as Cartesian,
      origin: down.origin,
    };
    expect(resolve(noisy, away)).toBe(resolve(noisy, null));
  });
});

/** GeographicProjection's semimajor axis (WGS84), Cesium's default map projection. */
const MAP_RADIUS = 6378137;

/** Geodetic degrees and height of an ECEF point (Bowring iteration): what
 * Cesium's `cartesianToCartographic` gives `projectTo2D` for each vertex. */
function cartographicOf([x, y, z]: readonly number[]): {
  height: number;
  lat: number;
  lon: number;
} {
  const a = 6378137;
  const b = 6356752.3142451793;
  const e2 = 1 - (b * b) / (a * a);
  const radius = Math.hypot(x, y);
  let lat = Math.atan2(z, radius * (1 - e2));
  let height = 0;
  for (let step = 0; step < 10; step += 1) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    height = radius / Math.cos(lat) - n;
    lat = Math.atan2(z, radius * (1 - (e2 * n) / (n + height)));
  }
  return {
    height,
    lat: (lat * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/** A vertex as Columbus view draws it: projected to `[lon·a, lat·a, height]`,
 * then moved by its ECEF elevation normal times the lift, which the shader
 * adds in the world frame's `(height, x, y)` order. */
function mapFrameVertex(
  positions: ArrayLike<number>,
  vertex: number,
  normals: ArrayLike<number> | null,
  lift: number,
): Cartesian {
  const { height, lat, lon } = cartographicOf([
    positions[vertex * 3],
    positions[vertex * 3 + 1],
    positions[vertex * 3 + 2],
  ]);
  const normal = normals
    ? [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]]
    : [0, 0, 0];
  return [
    ((lon * Math.PI) / 180) * MAP_RADIUS + normal[1] * lift,
    ((lat * Math.PI) / 180) * MAP_RADIUS + normal[2] * lift,
    height + normal[0] * lift,
  ];
}

/** The first triangle along the ray (Moller-Trumbore), or `null` when that
 * first hit lies on or near an edge, where either owner is right. */
function firstMeshHit(
  triangles: readonly Cartesian[][],
  owners: readonly number[],
  { direction, origin }: PickRay,
): { owner: number; t: number } | null {
  let best: { edge: number; owner: number; t: number } | null = null;
  triangles.forEach(([a, b, c], triangle) => {
    const e1 = [0, 1, 2].map((axis) => b[axis] - a[axis]);
    const e2 = [0, 1, 2].map((axis) => c[axis] - a[axis]);
    const p = [
      direction[1] * e2[2] - direction[2] * e2[1],
      direction[2] * e2[0] - direction[0] * e2[2],
      direction[0] * e2[1] - direction[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-9) return;
    const s = [0, 1, 2].map((axis) => origin[axis] - a[axis]);
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    const q = [
      s[1] * e1[2] - s[2] * e1[1],
      s[2] * e1[0] - s[0] * e1[2],
      s[0] * e1[1] - s[1] * e1[0],
    ];
    const v =
      (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    const edge = Math.min(u, v, 1 - u - v);
    if (edge < -1e-9 || t <= 0) return;
    if (best === null || t < best.t)
      best = { edge, owner: owners[triangle], t };
  });
  if (best === null) return null;
  const { edge, owner, t } = best;
  return edge < 1e-4 ? null : { owner, t };
}

const MAP_GEOMETRIES = ['triangles', 'hexagons', 'extruded'] as const;
/** Where the shader's ECEF normal shears the surface in the map frame:
 * mostly up and north at 45°N 10°E; sideways (and slightly down) at 30°N
 * 95°E; down at 30°S 150°E; mostly north at 75°N. */
const PLACES = {
  'mostly sideways (30°N 95°E)': latLngToCell(30, 95, RESOLUTION),
  'downwards (30°S 150°E)': latLngToCell(-30, 150, RESOLUTION),
  'mid-latitude (45°N 10°E)': MID_LATITUDE,
  'polar (75°N 20°E)': latLngToCell(75, 20, RESOLUTION),
};
/** The production grid's resolution: the only one in catalog.json. */
const PRODUCTION_RESOLUTION = 4;
/** PLACES on the production grid: the resolution-4 cell under each centre. */
const PRODUCTION_PLACES = Object.fromEntries(
  Object.entries(PLACES).map(([place, cell]) => {
    const [lat, lon] = cellToLatLng(cell);
    return [place, latLngToCell(lat, lon, PRODUCTION_RESOLUTION)];
  }),
);

/** The disk around `centre` as Columbus view draws it (`map`), or the globe in
 * ECEF (`globe`), with each triangle's row: rising heights so most rays meet a
 * wall or an overlap, and one masked ring cell whose flat support plate is
 * drawn unlifted. `mesh` is how a pick reads that drawing. */
function drawnDisk(
  geometry: (typeof MAP_GEOMETRIES)[number],
  centre: string,
  factor: number,
  radius = 1,
  frame: 'globe' | 'map' = 'map',
) {
  const ring = sortedU64(gridDisk(centre, radius)).filter(
    (cell) => cell !== centre,
  );
  const masked = ring[2];
  const { buffers, disk, heights, input, surface } = setup(
    geometry,
    centre,
    (h3) => ({
      support: h3 === masked ? 'unknown' : 'interpolated',
      // Rising round the first ring; further rings repeat the pattern.
      value: h3 === centre ? 0.95 : 0.1 + 0.12 * (ring.indexOf(h3) % 6),
    }),
    radius,
  );
  const meshed = (row: number) => isSupportedCode(input.support[row]);
  const triangles: Cartesian[][] = [];
  const owners: number[] = [];
  let triangle = 0;
  disk.forEach((_, row) => {
    if (!meshed(row)) return;
    const corners =
      input.topology.cornerOffsets[row + 1] - input.topology.cornerOffsets[row];
    const count = geometry === 'extruded' ? corners * 3 : corners;
    for (let index = 0; index < count; index += 1, triangle += 1) {
      triangles.push(
        [0, 1, 2].map((offset) => {
          const vertex = buffers.indices[triangle * 3 + offset];
          return frame === 'map'
            ? mapFrameVertex(
                buffers.positions,
                vertex,
                buffers.elevationNormals,
                buffers.heights[vertex] * factor,
              )
            : (displaced(buffers, vertex, factor) as Cartesian);
        }),
      );
      owners.push(row);
    }
  });
  expect(triangle, 'every surface triangle has a row').toBe(
    buffers.indices.length / 3,
  );
  const plate = buildSupportChunk(input, wholeGridChunk(input)).unknown!;
  for (let index = 0; index < plate.indices.length; index += 3) {
    triangles.push(
      [0, 1, 2].map((offset) => {
        const vertex = plate.indices[index + offset];
        return frame === 'map'
          ? mapFrameVertex(plate.positions, vertex, null, 0)
          : ([0, 1, 2].map(
              (axis) => plate.positions[vertex * 3 + axis],
            ) as Cartesian);
      }),
    );
    owners.push(disk.indexOf(masked));
  }
  const resolve = (point: Cartesian, ray: PickRay | null) =>
    resolveSurfaceRow(
      {
        cartesian: null,
        clearance: SURFACE_CLEARANCE_METRES,
        ellipsoidHit: null,
        factor,
        geometry,
        mapFrame: { point, ray },
      },
      surface,
      heights,
      meshed,
    );
  // As `resolveSurfaceRow` reads the scene's heights callback.
  const mesh: DrawnMesh = {
    clearance: SURFACE_CLEARANCE_METRES,
    geometry,
    maxLift: MAX_HEIGHT_METRES * factor,
    meshed,
    surface,
    top: (row) => Math.max(0, heights(row)) * factor,
  };
  return {
    masked: disk.indexOf(masked),
    mesh,
    owners,
    resolve,
    surface,
    triangles,
  };
}

describe('surface picks in the map frame (Columbus view and 2D, fast-load §B.6.6)', () => {
  /** A point inside each drawn triangle, so rays find the disk however far
   * the shear spread its cells. */
  function targetsOn(triangles: readonly Cartesian[][]): Cartesian[] {
    return triangles.map(
      ([a, b, c]) =>
        [0, 1, 2].map(
          (axis) => a[axis] * 0.25 + b[axis] * 0.35 + c[axis] * 0.4,
        ) as Cartesian,
    );
  }

  /** Rays from three camera positions, one nearly overhead and two oblique,
   * at each target. */
  function raysOver(triangles: readonly Cartesian[][]): PickRay[] {
    const targets = targetsOn(triangles);
    const centre = [0, 1].map(
      (axis) =>
        targets.reduce((total, target) => total + target[axis], 0) /
        targets.length,
    );
    const highest = Math.max(...triangles.flat().map(([, , h]) => h));
    const rays: PickRay[] = [];
    for (const [east, north] of [
      [30_000, 20_000],
      [900_000, -400_000],
      [-500_000, 800_000],
    ]) {
      const origin: Cartesian = [
        centre[0] + east,
        centre[1] + north,
        highest + 1_500_000,
      ];
      for (const target of targets) {
        const length = Math.hypot(
          ...[0, 1, 2].map((axis) => target[axis] - origin[axis]),
        );
        rays.push({
          direction: [0, 1, 2].map(
            (axis) => (target[axis] - origin[axis]) / length,
          ) as Cartesian,
          origin,
        });
      }
    }
    return rays;
  }

  for (const [place, centre] of Object.entries(PLACES))
    describe(place, () => {
      it.each(
        MAP_GEOMETRIES.flatMap((geometry) =>
          [1, 5].map((factor) => [geometry, factor] as const),
        ),
      )(
        'agrees with rays cast at the drawn %s mesh at exaggeration %d',
        (geometry, factor) => {
          const { owners, resolve, triangles } = drawnDisk(
            geometry,
            centre,
            factor,
          );
          let checked = 0;
          for (const ray of raysOver(triangles)) {
            const hit = firstMeshHit(triangles, owners, ray);
            if (hit === null) continue;
            // Depth-buffer noise moves the hit along the ray either way (Task
            // 69's probe measured up to about 16 km in a world view).
            for (const noise of [-16_000, -2_000, 0, 2_000, 16_000]) {
              const point = [0, 1, 2].map(
                (axis) =>
                  ray.origin[axis] + ray.direction[axis] * (hit.t + noise),
              ) as Cartesian;
              expect(resolve(point, ray), `noise ${noise}`).toBe(hit.owner);
            }
            checked += 1;
          }
          expect(checked, 'rays that meet the drawn disk').toBeGreaterThan(40);
        },
      );
    });

  // A hover has no depth hit (#483): the ray alone, over every height a lifted cell can reach.
  for (const [resolution, places] of [
    [RESOLUTION, PLACES],
    [PRODUCTION_RESOLUTION, PRODUCTION_PLACES],
  ] as const)
    for (const [place, centre] of Object.entries(places))
      it.each(
        MAP_GEOMETRIES.flatMap((geometry) =>
          [1, 5].map((factor) => [geometry, factor] as const),
        ),
      )(
        `finds the first drawn %s cell from the ray alone at ${place} on a resolution-${resolution} grid, at exaggeration %d (#483)`,
        (geometry, factor) => {
          const { mesh, owners, triangles } = drawnDisk(
            geometry,
            centre,
            factor,
          );
          let checked = 0;
          for (const ray of raysOver(triangles)) {
            const hit = firstMeshHit(triangles, owners, ray);
            if (hit === null) continue;
            expect(firstDrawnRowAlong(ray, mesh)).toBe(hit.owner);
            checked += 1;
          }
          expect(checked, 'rays that meet the drawn disk').toBeGreaterThan(40);
        },
      );

  /** The ray of a camera `metres` over (`lat`, `lon`) in the map frame, `heading` degrees east of
   * north and `pitch` degrees below the horizon. */
  function mapRay(
    lat: number,
    lon: number,
    metres: number,
    heading: number,
    pitch: number,
  ): PickRay {
    const [h, p] = [heading, pitch].map((degrees) => (degrees * Math.PI) / 180);
    return {
      direction: [
        Math.sin(h) * Math.cos(p),
        Math.cos(h) * Math.cos(p),
        -Math.sin(p),
      ],
      origin: [
        ((lon * Math.PI) / 180) * MAP_RADIUS,
        ((lat * Math.PI) / 180) * MAP_RADIUS,
        metres,
      ],
    };
  }

  // A shallow ray runs thousands of kilometres through the heights a lifted cell reaches, and
  // reaches the clearance past the pole or past 90°E, where the shear leans lifts down; near the
  // camera it can graze a sheared sheet of tops. The first cell it meets is still found (#483
  // review: a walk over the lift from the clearance-height ray point missed most of these). The
  // production grid (resolution 4) and grazing rays from over the lifted disk, which meet their
  // first cell within a few hundred kilometres of a trace running on for thousands, check that
  // the trace's stop past its first hit changes no answer (#506 review).
  it.each([
    ['extruded', RESOLUTION, 40],
    ['triangles', RESOLUTION, 40],
    ['extruded', PRODUCTION_RESOLUTION, 45],
    ['triangles', PRODUCTION_RESOLUTION, 45],
  ] as const)(
    'finds the first drawn %s cell along shallow and grazing rays on a resolution-%d grid (#483)',
    (geometry, resolution, radius) => {
      const { mesh, owners, triangles } = drawnDisk(
        geometry,
        latLngToCell(20, 10, resolution),
        5,
        radius,
      );
      let checked = 0;
      for (const metres of [100_000, 400_000, 800_000])
        for (const pitch of [0.2, 0.5, 1, 2, 4, 6])
          for (const [lat, lon, heading] of [
            [-15, 10, 0],
            [0, 10, 0],
            [10, 10, 0],
            [20, -15, 90],
            [20, 0, 90],
            [16, 12, 300],
            [24, 6, 135],
            [20, 18, 225],
          ]) {
            const ray = mapRay(lat, lon, metres, heading, pitch);
            const hit = firstMeshHit(triangles, owners, ray);
            if (hit === null) continue;
            expect(
              firstDrawnRowAlong(ray, mesh),
              `${metres / 1_000} km over ${lat}°, ${lon}°, ${pitch}° down, ${heading}° from north`,
            ).toBe(hit.owner);
            checked += 1;
          }
      expect(checked, 'rays that meet the drawn disk').toBeGreaterThan(50);
    },
    60_000,
  );

  // Where the shear is nearly sideways (n_x near 0 at 80°N 100°E) the trace can reach the cell a
  // ray meets first only from points far past that hit: here 250 km on. A stop a few of the
  // trace's columns past the first hit found misses it; the stop waits until no cell the trace
  // could still reach is drawn before that hit.
  it('keeps a first hit the trace reaches only from far past it, under a nearly sideways shear (#483)', () => {
    const { mesh, owners, triangles } = drawnDisk(
      'extruded',
      latLngToCell(80, 100, PRODUCTION_RESOLUTION),
      5,
      15,
    );
    // From 11 km up beyond the map's north edge (106.3°N, 91.6°E as the map draws it), looking
    // back south 0.23° down.
    const ray: PickRay = {
      direction: [
        -0.08574587736273084, -0.996309120221413, -0.003972590959174175,
      ],
      origin: [10_200_400.802116418, 11_836_927.246509183, 11_189.232206758319],
    };
    const hit = firstMeshHit(triangles, owners, ray);
    expect(hit, 'the ray meets the disk').not.toBeNull();
    expect(firstDrawnRowAlong(ray, mesh)).toBe(hit!.owner);
  });

  // The trace's work, counted rather than timed: rows tested (the layers' `drawn` callback) and
  // trace points placed in a cell (`latLngToCell`). A shallow ray's span runs on to the map's
  // edge, thousands of kilometres past its first hit; the trace stops once no cell it could
  // still reach can be drawn where the ray runs up to that hit (the #506 review measured up to
  // 21 ms a hover at resolution 4, exaggeration 5, before the stop). Over this disk the whole
  // trace tests 241 rows and places 5,494 points grazing, 357 and 2,158 shallow; the stop
  // brings that to 144 and 532, and 227 and 830.
  it('stops tracing once nothing it could still reach is drawn before its first hit, on a resolution-4 grid (#483)', () => {
    const { mesh, owners, triangles } = drawnDisk(
      'extruded',
      latLngToCell(20, 10, PRODUCTION_RESOLUTION),
      5,
      60,
    );
    for (const [ray, most] of [
      // Grazing east from over the disk: the first hit is 10 km on.
      [mapRay(20, 4, 100_000, 90, 0.5), { points: 1_500, rows: 190 }],
      // Shallow, north from beyond the disk: the first hit is 850 km on.
      [mapRay(2, 10, 400_000, 0, 3), { points: 1_500, rows: 290 }],
    ] as const) {
      const hit = firstMeshHit(triangles, owners, ray);
      expect(hit, 'the ray meets the disk').not.toBeNull();
      let rows = 0;
      const placed = h3Calls.latLngToCell;
      const row = firstDrawnRowAlong(ray, {
        ...mesh,
        drawn: () => {
          rows += 1;
          return true;
        },
      });
      const points = h3Calls.latLngToCell - placed;
      expect(row).toBe(hit!.owner);
      expect(rows, 'rows tested').toBeLessThanOrEqual(most.rows);
      expect(points, 'trace points placed').toBeLessThanOrEqual(most.points);
    }
  }, 60_000);

  it.each(MAP_GEOMETRIES)(
    'keeps its answer under depth noise up to the window on a resolution-7 grid (%s)',
    (geometry) => {
      // Cells about 2.5 km across: 18 km of noise along an oblique ray moves
      // the hit several cells sideways, so the walk has to follow the ray,
      // not the hit.
      const { owners, resolve, triangles } = drawnDisk(
        geometry,
        latLngToCell(45, 10, 7),
        1,
        3,
      );
      let checked = 0;
      for (const ray of raysOver(triangles)) {
        const hit = firstMeshHit(triangles, owners, ray);
        if (hit === null) continue;
        for (const noise of [-18_000, 18_000]) {
          const point = [0, 1, 2].map(
            (axis) => ray.origin[axis] + ray.direction[axis] * (hit.t + noise),
          ) as Cartesian;
          expect(resolve(point, ray), `noise ${noise}`).toBe(hit.owner);
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    },
    // CPU-bound: about 3 s alone on an idle Apple-silicon machine and up to 6.5 s in a loaded
    // full-suite run, past vitest's 5 s default (CI runs on slower ubuntu-latest cores).
    60_000,
  );

  it('resolves hits the radial projection gives to another cell', () => {
    // The globe's projection, applied to the ECEF point Cesium returns for a
    // Columbus-view hit, misses the drawn cell for most of these rays.
    const factor = 1;
    const { owners, resolve, surface, triangles } = drawnDisk(
      'triangles',
      MID_LATITUDE,
      factor,
    );
    let radialMisses = 0;
    let checked = 0;
    for (const ray of raysOver(triangles)) {
      const hit = firstMeshHit(triangles, owners, ray);
      if (hit === null) continue;
      const point = [0, 1, 2].map(
        (axis) => ray.origin[axis] + ray.direction[axis] * hit.t,
      ) as Cartesian;
      const ecef = [0, 0, 0];
      geodeticToEcef(
        (point[0] / MAP_RADIUS) * (180 / Math.PI),
        (point[1] / MAP_RADIUS) * (180 / Math.PI),
        point[2],
        ecef,
      );
      const radial = resolveSurfaceRow(
        {
          cartesian: ecef as Cartesian,
          clearance: SURFACE_CLEARANCE_METRES,
          ellipsoidHit: null,
          factor,
          geometry: 'triangles',
        },
        surface,
        () => 0,
      );
      if (radial !== hit.owner) radialMisses += 1;
      expect(resolve(point, ray)).toBe(hit.owner);
      checked += 1;
    }
    expect(radialMisses / checked).toBeGreaterThan(0.5);
  });

  it.each(MAP_GEOMETRIES)(
    'reads the base from the hit height without a ray where the shear is mostly upward (%s)',
    (geometry) => {
      const { owners, resolve, triangles } = drawnDisk(
        geometry,
        MID_LATITUDE,
        5,
      );
      let checked = 0;
      for (const target of targetsOn(triangles)) {
        // Straight down, so an exact hit lies on a top or a fan, not a wall.
        const nadir: PickRay = {
          direction: [0, 0, -1],
          origin: [target[0], target[1], target[2] + 2_000_000],
        };
        const hit = firstMeshHit(triangles, owners, nadir);
        if (hit === null) continue;
        const point = [0, 1, 2].map(
          (axis) => nadir.origin[axis] + nadir.direction[axis] * hit.t,
        ) as Cartesian;
        expect(resolve(point, null)).toBe(resolve(point, nadir));
        expect(resolve(point, null)).toBe(hit.owner);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(20);
    },
  );

  it('moves a hit Cesium returned one map width away back onto the ray', () => {
    // Cesium returns the depth hit through cartesianToCartographic, so a
    // surface the shear pushes past ±180° comes back on the far side.
    const { owners, resolve, triangles } = drawnDisk(
      'hexagons',
      MID_LATITUDE,
      5,
    );
    const width = 2 * Math.PI * MAP_RADIUS;
    let checked = 0;
    for (const ray of raysOver(triangles)) {
      const hit = firstMeshHit(triangles, owners, ray);
      if (hit === null) continue;
      const point = [0, 1, 2].map(
        (axis) => ray.origin[axis] + ray.direction[axis] * hit.t,
      ) as Cartesian;
      for (const shift of [-width, width])
        expect(resolve([point[0] + shift, point[1], point[2]], ray)).toBe(
          hit.owner,
        );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe('a hover’s lifted pick on the globe, from the pick ray alone (#483)', () => {
  /** A point inside each drawn triangle. */
  function targetsOn(triangles: readonly Cartesian[][]): Cartesian[] {
    return triangles.map(
      ([a, b, c]) =>
        [0, 1, 2].map(
          (axis) => a[axis] * 0.25 + b[axis] * 0.35 + c[axis] * 0.4,
        ) as Cartesian,
    );
  }

  /** Rays in ECEF from three cameras 1,500 km up, one nearly overhead and two
   * oblique, at a point inside each triangle. */
  function raysOver(triangles: readonly Cartesian[][]): PickRay[] {
    const targets = targetsOn(triangles);
    const centre = [0, 1, 2].map(
      (axis) =>
        targets.reduce((total, target) => total + target[axis], 0) /
        targets.length,
    );
    const up = centre.map((axis) => axis / Math.hypot(...centre));
    const eastward = [-up[1], up[0], 0];
    const east = eastward.map((axis) => axis / Math.hypot(...eastward));
    const north = [
      up[1] * east[2] - up[2] * east[1],
      up[2] * east[0] - up[0] * east[2],
      up[0] * east[1] - up[1] * east[0],
    ];
    const rays: PickRay[] = [];
    for (const [across, along] of [
      [30_000, 20_000],
      [900_000, -400_000],
      [-500_000, 800_000],
    ]) {
      const origin = [0, 1, 2].map(
        (axis) =>
          centre[axis] +
          up[axis] * 1_500_000 +
          east[axis] * across +
          north[axis] * along,
      ) as Cartesian;
      for (const target of targets) {
        const length = Math.hypot(
          ...[0, 1, 2].map((axis) => target[axis] - origin[axis]),
        );
        rays.push({
          direction: [0, 1, 2].map(
            (axis) => (target[axis] - origin[axis]) / length,
          ) as Cartesian,
          origin,
        });
      }
    }
    return rays;
  }

  for (const [place, centre] of Object.entries(PLACES))
    it.each(
      MAP_GEOMETRIES.flatMap((geometry) =>
        [1, 5].map((factor) => [geometry, factor] as const),
      ),
    )(
      `meets the drawn %s cell the ray meets first at ${place}, at exaggeration %d`,
      (geometry, factor) => {
        const { mesh, owners, triangles } = drawnDisk(
          geometry,
          centre,
          factor,
          1,
          'globe',
        );
        let checked = 0;
        for (const ray of raysOver(triangles)) {
          const hit = firstMeshHit(triangles, owners, ray);
          if (hit === null) continue;
          expect(firstLiftedRow(ray, mesh)).toBe(hit.owner);
          checked += 1;
        }
        expect(checked, 'rays that meet the drawn disk').toBeGreaterThan(40);
      },
    );

  it.each(MAP_GEOMETRIES)(
    'passes through the cells a layer does not draw (%s)',
    (geometry) => {
      const { mesh, owners, triangles } = drawnDisk(
        geometry,
        MID_LATITUDE,
        5,
        1,
        'globe',
      );
      for (const drawn of [
        // The surface layer off: only the masked cell's support plate is drawn.
        (row: number) => !mesh.meshed(row),
        // The support layer off.
        (row: number) => mesh.meshed(row),
      ]) {
        const kept = triangles.filter((_, index) => drawn(owners[index]));
        const keptOwners = owners.filter((owner) => drawn(owner));
        let checked = 0;
        for (const ray of raysOver(triangles)) {
          const row = firstLiftedRow(ray, { ...mesh, drawn });
          if (row !== null) expect(drawn(row), 'a drawn cell').toBe(true);
          const hit = firstMeshHit(kept, keptOwners, ray);
          if (hit === null) continue;
          expect(row).toBe(hit.owner);
          checked += 1;
        }
        expect(checked).toBeGreaterThan(5);
      }
    },
  );

  it('meets nothing where the ray misses the disk, or stays above it', () => {
    const { mesh, triangles } = drawnDisk(
      'triangles',
      MID_LATITUDE,
      5,
      1,
      'globe',
    );
    const [ray] = raysOver(triangles);
    // Turned away from the Earth.
    expect(
      firstLiftedRow(
        {
          direction: ray.direction.map((axis) => -axis) as Cartesian,
          origin: ray.origin,
        },
        mesh,
      ),
    ).toBeNull();
    // Down onto the ground 2,000 km away.
    const far = [0, 0, 0];
    geodeticToEcef(10 + 25, 45, 0, far);
    const towards = far.map((axis, index) => axis - ray.origin[index]);
    const length = Math.hypot(...towards);
    expect(
      firstLiftedRow(
        {
          direction: towards.map((axis) => axis / length) as Cartesian,
          origin: ray.origin,
        },
        mesh,
      ),
    ).toBeNull();
  });
});
