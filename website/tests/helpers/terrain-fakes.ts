/**
 * A globe with the parts of Cesium 1.145's private terrain quadtree that the ground under the
 * draped observations and the highlight reads (`scene/ground-points.ts`; terrain draping design,
 * "Per layer under World Terrain", "Exaggeration", #483): Cesium's own two level-zero tiles of
 * the geographic tiling scheme (west and east of 0°), each with a real `GlobeSurfaceTile` whose
 * rendered mesh draws its source heights × the mesh's exaggeration, from its relative height.
 * `getHeight` counts its picks and reads the rendered mesh of the tile under the point, as
 * `Globe.getHeight` does; Cesium's own descent through deeper tiles is pinned against the copy
 * in atlas-cesium-internals.test.ts.
 */

import {
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  Math as CesiumMath,
  Rectangle,
  type Cartographic,
} from 'cesium';
import * as Cesium from 'cesium';
import { vi } from 'vitest';

/** The source height (metres) at a point in degrees; undefined where a pick finds no ground. */
export type GroundAt = (lonDeg: number, latDeg: number) => number | undefined;

/** A terrain mesh: its encoding's exaggeration, which a relief change sets, and its source. */
export interface FakeMesh {
  readonly encoding: {
    exaggeration: number;
    exaggerationRelativeHeight: number;
  };
  readonly source: GroundAt;
}

interface SurfaceTileInternals {
  mesh: FakeMesh | undefined;
  vertexArray: object | undefined;
  fill: { mesh: FakeMesh } | undefined;
  terrainData:
    | {
        interpolateHeight(
          r: Rectangle,
          lon: number,
          lat: number,
        ): number | undefined;
      }
    | undefined;
  readonly renderedMesh: FakeMesh | undefined;
}

interface QuadtreeTileInternals {
  readonly rectangle: Rectangle;
  data: SurfaceTileInternals | undefined;
}

const internals = Cesium as unknown as {
  GlobeSurfaceTile: new () => SurfaceTileInternals;
  QuadtreeTile: {
    createLevelZeroTiles(
      scheme: GeographicTilingScheme,
    ): QuadtreeTileInternals[];
  };
};

/** Which level-zero tile: west of 0° (x 0) or east of it (x 1). */
export type Hemisphere = 'west' | 'east';

export interface FakeTerrain {
  readonly globe: {
    getHeight: ReturnType<
      typeof vi.fn<(c: Cartographic) => number | undefined>
    >;
    _surface: {
      _levelZeroTiles: QuadtreeTileInternals[] | undefined;
      tileProvider: { terrainProvider: object };
    };
  };
  /** The tile's rendered mesh, if it has one. */
  meshOf(which: Hemisphere): FakeMesh | undefined;
  /** New meshes on the tiles named (both by default), drawing `ground`: terrain tiles loaded. */
  load(ground: GroundAt, ...which: Hemisphere[]): void;
  /**
   * A fill mesh drawn on the tiles named (both by default), built from neighbouring edges while
   * the tile's own mesh is not ready: the tile's terrain data, if any, is not what it draws.
   */
  fill(ground: GroundAt, ...which: Hemisphere[]): void;
  /** No rendered mesh on the tiles named (both by default): not loaded yet, or freed. */
  unload(...which: Hemisphere[]): void;
  /** Every mesh re-exaggerated in place, as the frame after a relief change does. */
  setRelief(exaggeration: number, relativeHeight?: number): void;
  /** World Terrain's provider reaches the tiles, which were the smooth globe's until now. */
  apply(): void;
}

/**
 * `ground` on both level-zero tiles, at relief 1 from sea level. With `applied: false` the tiles
 * are still the smooth globe's (`EllipsoidTerrainProvider`), until `apply`.
 */
export function fakeTerrain(
  ground: GroundAt,
  options: { applied?: boolean } = {},
): FakeTerrain {
  const tiles = internals.QuadtreeTile.createLevelZeroTiles(
    new GeographicTilingScheme(),
  );
  const index = { east: 1, west: 0 } as const;
  const relief = { exaggeration: 1, exaggerationRelativeHeight: 0 };
  const meshFor = (source: GroundAt): FakeMesh => ({
    encoding: { ...relief },
    source,
  });
  const surfaceOf = (which: Hemisphere): SurfaceTileInternals => {
    const tile = tiles[index[which]];
    tile.data ??= new internals.GlobeSurfaceTile();
    return tile.data;
  };
  const both = (which: Hemisphere[]): Hemisphere[] =>
    which.length > 0 ? which : ['west', 'east'];
  const load = (source: GroundAt, ...which: Hemisphere[]) => {
    for (const hemisphere of both(which)) {
      const data = surfaceOf(hemisphere);
      data.mesh = meshFor(source);
      data.vertexArray = {};
      data.fill = undefined;
      data.terrainData = {
        interpolateHeight: (_r, lon, lat) =>
          source(CesiumMath.toDegrees(lon), CesiumMath.toDegrees(lat)),
      };
    }
  };
  const globe: FakeTerrain['globe'] = {
    getHeight: vi.fn((c: Cartographic) => {
      const tile = tiles.find((t) => Rectangle.contains(t.rectangle, c));
      const mesh = tile?.data?.renderedMesh;
      const source = mesh?.source(
        CesiumMath.toDegrees(c.longitude),
        CesiumMath.toDegrees(c.latitude),
      );
      if (mesh === undefined || source === undefined) return undefined;
      const { exaggeration, exaggerationRelativeHeight } = mesh.encoding;
      return (
        (source - exaggerationRelativeHeight) * exaggeration +
        exaggerationRelativeHeight
      );
    }),
    _surface: {
      _levelZeroTiles: tiles,
      tileProvider: {
        terrainProvider:
          options.applied === false ? new EllipsoidTerrainProvider() : {},
      },
    },
  };
  load(ground);
  return {
    globe,
    meshOf: (which) => tiles[index[which]].data?.renderedMesh,
    load,
    fill(source, ...which) {
      for (const hemisphere of both(which)) {
        const data = surfaceOf(hemisphere);
        data.vertexArray = undefined;
        data.fill = { mesh: meshFor(source) };
      }
    },
    unload(...which) {
      for (const hemisphere of both(which))
        tiles[index[hemisphere]].data = undefined;
    },
    setRelief(exaggeration, relativeHeight = 0) {
      relief.exaggeration = exaggeration;
      relief.exaggerationRelativeHeight = relativeHeight;
      for (const tile of tiles) {
        const mesh = tile.data?.renderedMesh;
        if (mesh) Object.assign(mesh.encoding, relief);
      }
    },
    apply() {
      globe._surface.tileProvider.terrainProvider = {};
    },
  };
}
