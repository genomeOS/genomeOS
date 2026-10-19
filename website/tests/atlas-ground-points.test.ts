/** The ground under fixed points on World Terrain, read once per rendered terrain mesh and followed
 * through relief without a pick (terrain draping design, "Per layer under World Terrain",
 * "Exaggeration" and "Failure modes"; #483): on a fake quadtree that counts picks, and on real
 * Cesium 1.145 heightmap meshes of the e2e build's synthetic terrain. */
import {
  Cartesian3,
  Cartographic,
  GeographicTilingScheme,
  Globe,
  type HeightmapTerrainData,
  Math as CesiumMath,
  TaskProcessor,
} from 'cesium';
import * as Cesium from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroundPoints } from '../src/atlas/scene/ground-points';
import {
  createSyntheticTerrain,
  SYNTHETIC_CONE,
  SYNTHETIC_PEAK,
} from '../src/atlas/scene/synthetic-terrain';
import { fakeTerrain } from './helpers/terrain-fakes';

/** The Spain survey on the synthetic peak (map-surveys:1135), then the Gabon survey (map-surveys:996). */
const POINTS = Float64Array.of(-3.709, 40.419, 12.686, -1.844);
const WEST = 1_000 + 10 * 40.419;
const EAST = 1_000 + 10 * -1.844;
/** 1,000 m plus 10 m per degree of latitude, on both tiles. */
const slope = (_lon: number, lat: number) => 1_000 + 10 * lat;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ground points on World Terrain', () => {
  it('picks the ground under each point once, on the mesh under it, NaN where no tile has one', () => {
    const terrain = fakeTerrain(slope);
    terrain.unload('east');
    const points = new GroundPoints(POINTS);
    expect(Array.from(points.heights)).toEqual([Number.NaN, Number.NaN]);
    expect(points.update(terrain.globe)).toEqual({
      changed: true,
      pending: 0,
      picked: 1,
    });
    expect(Array.from(points.heights)).toEqual([WEST, Number.NaN]);
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(1);
  });

  it('keeps NaN, without picking again, where the mesh under a point has no ground for it', () => {
    const terrain = fakeTerrain((lon) => (lon < 0 ? 6_000 : undefined));
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    expect(Array.from(points.heights)).toEqual([6_000, Number.NaN]);
    expect(points.update(terrain.globe)).toEqual({
      changed: false,
      pending: 0,
      picked: 0,
    });
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(2);
  });

  it('picks nothing on a pass over tiles whose meshes have not changed', () => {
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    expect(points.update(terrain.globe)).toEqual({
      changed: false,
      pending: 0,
      picked: 0,
    });
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(2);
  });

  it('follows a relief change from each point’s source height, with no pick', () => {
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    terrain.globe.getHeight.mockClear();
    terrain.setRelief(3);
    expect(points.update(terrain.globe)).toEqual({
      changed: true,
      pending: 0,
      picked: 0,
    });
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
    expect(points.heights[0]).toBeCloseTo(WEST * 3, 9);
    expect(points.heights[1]).toBeCloseTo(EAST * 3, 9);
    terrain.setRelief(1);
    points.update(terrain.globe);
    expect(Array.from(points.heights)).toEqual([WEST, EAST]);
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
  });

  it('follows relief exaggerated from a height other than sea level', () => {
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(POINTS);
    terrain.setRelief(2, 300);
    points.update(terrain.globe);
    expect(points.heights[0]).toBeCloseTo((WEST - 300) * 2 + 300, 9);
    terrain.globe.getHeight.mockClear();
    terrain.setRelief(4, 500);
    points.update(terrain.globe);
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
    expect(points.heights[0]).toBeCloseTo((WEST - 500) * 4 + 500, 9);
    expect(points.heights[1]).toBeCloseTo((EAST - 500) * 4 + 500, 9);
  });

  it('picks again only the points whose rendered mesh changed', () => {
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    terrain.globe.getHeight.mockClear();
    terrain.load(() => 2_000, 'east');
    expect(points.update(terrain.globe)).toEqual({
      changed: true,
      pending: 0,
      picked: 1,
    });
    expect(Array.from(points.heights)).toEqual([WEST, 2_000]);
    const [[picked]] = terrain.globe.getHeight.mock.calls;
    expect(CesiumMath.toDegrees(picked.longitude)).toBeCloseTo(12.686, 9);
  });

  it('picks again, as the relief changes, a point drawn on a fill mesh, whose source height it cannot read', () => {
    const terrain = fakeTerrain(slope);
    terrain.fill(() => 2_500, 'east');
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    expect(Array.from(points.heights)).toEqual([WEST, 2_500]);
    terrain.globe.getHeight.mockClear();
    terrain.setRelief(2);
    expect(points.update(terrain.globe)).toEqual({
      changed: true,
      pending: 0,
      picked: 1,
    });
    expect(points.heights[0]).toBeCloseTo(WEST * 2, 9);
    expect(points.heights[1]).toBe(5_000);
  });

  it('reads NaN once no tile under a point has a mesh, and picks it again when one loads', () => {
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(POINTS);
    points.update(terrain.globe);
    terrain.unload('east');
    expect(points.update(terrain.globe)).toEqual({
      changed: true,
      pending: 0,
      picked: 0,
    });
    expect(Array.from(points.heights)).toEqual([WEST, Number.NaN]);
    terrain.load(() => 3_000, 'east');
    expect(points.update(terrain.globe)).toMatchObject({ picked: 1 });
    expect(Array.from(points.heights)).toEqual([WEST, 3_000]);
  });

  it('wraps a longitude past 180° into the range where the tiles are', () => {
    // Globe.getHeight finds no level-zero tile for a longitude outside [-180°, 180°].
    const terrain = fakeTerrain(slope);
    const points = new GroundPoints(
      Float64Array.of(-3.709 + 360, 40.419, 12.686 - 360, -1.844),
    );
    points.update(terrain.globe);
    expect(points.heights[0]).toBeCloseTo(WEST, 9);
    expect(points.heights[1]).toBeCloseTo(EAST, 9);
  });

  it('reads nothing while the tiles on the globe are still the smooth globe’s', () => {
    // World Terrain is on the globe, but Cesium makes its tiles only in the next frame.
    const terrain = fakeTerrain(slope, { applied: false });
    const points = new GroundPoints(POINTS);
    expect(points.update(terrain.globe)).toEqual({
      changed: false,
      pending: 0,
      picked: 0,
    });
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
    expect(Array.from(points.heights)).toEqual([Number.NaN, Number.NaN]);
    terrain.apply();
    expect(points.update(terrain.globe)).toMatchObject({ picked: 2 });
    expect(Array.from(points.heights)).toEqual([WEST, EAST]);
  });

  it('spends no more pick time than its budget, and leaves the rest for the next pass', () => {
    const clock = { now: 0 };
    const terrain = fakeTerrain(slope);
    const pick = terrain.globe.getHeight.getMockImplementation()!;
    terrain.globe.getHeight.mockImplementation((c) => {
      clock.now += 1; // each pick takes 1 ms
      return pick(c);
    });
    const many = Float64Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0 ? -60 + 10 * i : -30 + 4 * i,
    );
    const points = new GroundPoints(many);
    let left = 3;
    const budget = {
      remainingMs: () => left,
      spend: (ms: number) => {
        left -= ms;
      },
    };
    const limit = { budget, now: () => clock.now };
    expect(points.update(terrain.globe, limit)).toEqual({
      changed: true,
      pending: 5,
      picked: 3,
    });
    expect(left).toBe(0);
    expect(points.update(terrain.globe, limit)).toEqual({
      changed: false,
      pending: 5,
      picked: 0,
    });
    left = 3;
    expect(points.update(terrain.globe, limit)).toMatchObject({
      pending: 2,
      picked: 3,
    });
    left = 3;
    expect(points.update(terrain.globe, limit)).toMatchObject({
      pending: 0,
      picked: 2,
    });
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(8);
    expect(Array.from(points.heights).every(Number.isFinite)).toBe(true);
  });

  it('picks the points above the camera’s horizon first', () => {
    const terrain = fakeTerrain(slope);
    // Behind the globe, in view, behind, in view: the camera is 2,000 km over Madrid.
    const points = new GroundPoints(
      Float64Array.of(176, -40, -3.7, 40.4, 150, 10, 2, 45),
    );
    let left = 2;
    const limit = {
      budget: {
        remainingMs: () => left,
        spend: () => {
          left -= 1;
        },
      },
      now: () => 0,
      viewer: Cartesian3.fromDegrees(-3.7, 40.4, 2_000_000),
    };
    expect(points.update(terrain.globe, limit)).toMatchObject({
      pending: 2,
      picked: 2,
    });
    expect(Array.from(points.heights, Number.isFinite)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('refuses points that are not finite lon, lat pairs', () => {
    expect(() => new GroundPoints(Float64Array.of(1, 2, 3))).toThrow(
      /lon, lat pairs: got 3 numbers/,
    );
    expect(
      () => new GroundPoints(Float64Array.of(1, 2, 3, Number.NaN)),
    ).toThrow(/finite lon, lat pairs: pair 1 is \(3, NaN\)/);
  });

  it('fails loudly on a globe without Cesium’s terrain quadtree', () => {
    const points = new GroundPoints(POINTS);
    expect(() => points.update({ getHeight: () => 0 } as never)).toThrow(
      /terrain quadtree/,
    );
  });
});

interface SurfaceTileInternals {
  mesh: unknown;
  vertexArray: unknown;
  terrainData: HeightmapTerrainData | undefined;
  readonly renderedMesh: { encoding: { exaggeration: number } } | undefined;
}
interface QuadtreeTileInternals {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly rectangle: Cesium.Rectangle;
  readonly southwestChild: QuadtreeTileInternals;
  readonly southeastChild: QuadtreeTileInternals;
  readonly northwestChild: QuadtreeTileInternals;
  readonly northeastChild: QuadtreeTileInternals;
  data: SurfaceTileInternals | undefined;
}
const internals = Cesium as unknown as {
  GlobeSurfaceTile: new () => SurfaceTileInternals;
  QuadtreeTile: {
    createLevelZeroTiles(s: GeographicTilingScheme): QuadtreeTileInternals[];
  };
};

/**
 * A globe whose quadtree holds Cesium's own tiles down to `level` under each point, each with a
 * real 33 × 33 heightmap mesh of the synthetic terrain exaggerated `exaggeration` times, picked
 * by Cesium's own `Globe.getHeight`.
 */
async function realTerrain(
  points: Float64Array,
  level: number,
  exaggeration: number,
) {
  const provider = createSyntheticTerrain();
  const tilingScheme = provider.tilingScheme as GeographicTilingScheme;
  const levelZero = internals.QuadtreeTile.createLevelZeroTiles(tilingScheme);
  const meshed: QuadtreeTileInternals[] = [];
  for (let index = 0; index < points.length; index += 2) {
    const point = Cartographic.fromDegrees(points[index], points[index + 1]);
    const contains = (t: QuadtreeTileInternals) =>
      Cesium.Rectangle.contains(t.rectangle, point);
    let tile = levelZero.find(contains)!;
    while (tile.level < level)
      tile = [
        tile.southwestChild,
        tile.southeastChild,
        tile.northwestChild,
        tile.northeastChild,
      ].find(contains)!;
    if (tile.data) continue;
    const data = new internals.GlobeSurfaceTile();
    const terrainData = (await provider.requestTileGeometry(
      tile.x,
      tile.y,
      tile.level,
    )) as HeightmapTerrainData;
    data.terrainData = terrainData;
    data.mesh = (
      terrainData as unknown as {
        _createMeshSync(o: object): unknown;
      }
    )._createMeshSync({
      exaggeration,
      exaggerationRelativeHeight: 0,
      level: tile.level,
      tilingScheme,
      x: tile.x,
      y: tile.y,
    });
    data.vertexArray = {};
    tile.data = data;
    meshed.push(tile);
  }
  const surface = {
    _levelZeroTiles: levelZero,
    _tileProvider: { terrainProvider: provider, tilingScheme },
    tileProvider: { terrainProvider: provider },
  };
  const globe = {
    _surface: surface,
    getHeight: vi.fn((c: Cartographic) =>
      Globe.prototype.getHeight.call({ _surface: surface }, c),
    ),
  };
  return {
    globe,
    /** Each mesh's encoding re-exaggerated, as GlobeSurfaceTile.updateExaggeration writes it. */
    setRelief(k: number) {
      for (const tile of meshed)
        tile.data!.renderedMesh!.encoding.exaggeration = k;
    },
  };
}

/** Points on the slopes of the synthetic peak and cone, where the source height is not 0. */
function slopePoints(): Float64Array {
  const pairs: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    pairs.push(
      SYNTHETIC_PEAK.lon + ((i % 8) - 4) * 0.15,
      SYNTHETIC_PEAK.lat + (Math.floor(i / 8) - 2) * 0.15,
      SYNTHETIC_CONE.lon + ((i % 8) - 4) * 0.2,
      SYNTHETIC_CONE.lat + (Math.floor(i / 8) - 2) * 0.2,
    );
  }
  pairs.push(...POINTS);
  return Float64Array.from(pairs);
}

// The rule the ground follows on a relief change, measured against Cesium's own picks of meshes
// built at relief 3 (perfinv/synth/rescale-accuracy.mjs measured 26.8 m at level 2, 6 m at level 4
// and at most 0.4 m from level 6; dividing by the exaggeration instead is 1.9 km off at level 2).
describe('relief followed on real Cesium meshes (synthetic terrain)', () => {
  it.each([
    [2, 30],
    [6, 1],
    [8, 1],
  ])(
    'stays within the re-exaggerated mesh’s ground at level %i to %i m, with no pick',
    async (level, toleranceMetres) => {
      // The picker's worker never answers inside a synchronous pass: every pick scans the tile.
      vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockReturnValue(
        new Promise(() => {}),
      );
      const points = slopePoints();
      const followed = await realTerrain(points, level, 1);
      const ground = new GroundPoints(points);
      ground.update(followed.globe);
      expect(Array.from(ground.heights).every(Number.isFinite)).toBe(true);
      const atRelief1 = ground.heights.slice();
      followed.globe.getHeight.mockClear();
      followed.setRelief(3);
      expect(ground.update(followed.globe)).toMatchObject({ picked: 0 });
      expect(followed.globe.getHeight).not.toHaveBeenCalled();

      const truth = new GroundPoints(points);
      truth.update((await realTerrain(points, level, 3)).globe);
      const errors = Array.from(ground.heights, (h, i) =>
        Math.abs(h - truth.heights[i]),
      );
      expect(Math.max(...errors)).toBeLessThanOrEqual(toleranceMetres);
      // The relief raised the slopes by far more than that: the rule moved the ground.
      const raised = Array.from(ground.heights, (h, i) => h - atRelief1[i]);
      expect(Math.max(...raised)).toBeGreaterThan(100 * toleranceMetres);
    },
  );
});
