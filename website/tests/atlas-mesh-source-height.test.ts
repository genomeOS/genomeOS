/** The source height under a point of a terrain mesh, read from the mesh of a quantized-mesh tile
 * (World Terrain's format) where Cesium's own read finds nothing once the mesh exists (terrain
 * draping design, "Exaggeration"; #483). On Cesium's own meshes, built by its own mesh worker. */
import {
  GeographicTilingScheme,
  Math as CesiumMath,
  TaskProcessor,
  type Rectangle,
} from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meshSourceHeight } from '../src/atlas/scene/mesh-source-height';
import {
  isQuantizedMeshTask,
  quantizedMesh,
  quantizedTile,
  runQuantizedMeshTask,
} from './helpers/quantized-terrain';

const TILING = new GeographicTilingScheme();

/** A 6 km Gaussian peak, σ 40 km, under the synthetic terrain's (−3.709°, 40.419°). */
function peak(longitude: number, latitude: number): number {
  const east = (CesiumMath.toDegrees(longitude) + 3.709) * 85;
  const north = (CesiumMath.toDegrees(latitude) - 40.419) * 111;
  return 6_000 * Math.exp(-(east * east + north * north) / (2 * 40 * 40));
}

/** The tile at `level` under the peak, as a quantized tile of it. */
function peakTile(level: number) {
  const { x, y } = TILING.positionToTileXY(
    { height: 0, latitude: 0.7054, longitude: -0.0647 } as never,
    level,
  )!;
  return {
    data: quantizedTile(TILING, x, y, level, peak),
    level,
    rectangle: TILING.tileXYToRectangle(x, y, level),
    x,
    y,
  };
}

/** 200 points spread over `rectangle`, in radians. */
function spread(rectangle: Rectangle): [number, number][] {
  return Array.from({ length: 200 }, (_, i) => [
    rectangle.west + ((i * 0.618_034) % 1) * rectangle.width,
    rectangle.south + ((i * 0.377_215) % 1) * rectangle.height,
  ]);
}

beforeEach(() => {
  vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(
    (parameters: unknown) =>
      isQuantizedMeshTask(parameters)
        ? (runQuantizedMeshTask(parameters as object) as never)
        : new Promise(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('meshSourceHeight', () => {
  it.each([4, 8, 10])(
    'reads at level %i the source height Cesium’s quantized data reads before its mesh exists, whatever the mesh’s relief',
    async (level) => {
      const tile = peakTile(level);
      const points = spread(tile.rectangle);
      const before = points.map(([lon, lat]) =>
        tile.data.interpolateHeight(tile.rectangle, lon, lat)!,
      );
      expect(before.every(Number.isFinite)).toBe(true);
      const mesh = await quantizedMesh(
        tile.data,
        TILING,
        tile.x,
        tile.y,
        level,
        3,
      );
      for (const [k, [lon, lat]] of points.entries())
        expect(meshSourceHeight(mesh, tile.rectangle, lon, lat)).toBeCloseTo(
          before[k],
          2,
        );
    },
  );

  it('decodes each mesh’s vertices once, on its first read', async () => {
    const tile = peakTile(8);
    const mesh = await quantizedMesh(tile.data, TILING, tile.x, tile.y, 8, 1);
    const decodeHeight = vi.spyOn(mesh.encoding, 'decodeHeight');
    const [first, second] = spread(tile.rectangle);
    meshSourceHeight(mesh, tile.rectangle, ...first);
    expect(decodeHeight).toHaveBeenCalledTimes(33 * 33);
    meshSourceHeight(mesh, tile.rectangle, ...second);
    expect(decodeHeight).toHaveBeenCalledTimes(33 * 33);
  });

  it('fails loudly on a mesh without the members of Cesium 1.145’s TerrainMesh', () => {
    const tile = peakTile(4);
    expect(() =>
      meshSourceHeight({ vertices: [] }, tile.rectangle, -0.0647, 0.7054),
    ).toThrow(/TerrainMesh/);
  });
});
