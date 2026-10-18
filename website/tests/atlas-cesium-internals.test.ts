/**
 * Pins the Cesium 1.145 internals the draped Atlas layers rely on (terrain draping design, "Failure
 * modes", #483). A Cesium upgrade that changes one of them fails here before the draped layers
 * misbehave: a layer at alpha 0 draws no texture, a hidden layer frees its tiles, alpha is a plain
 * number the tile shader reads, the imagery cache layout that resident bytes count, the flipped
 * decode that south-first bitmaps match, and the base-layer rule the draped base guard answers.
 * Also the cache of ground positions a relief change leaves stale ("Exaggeration"), which the
 * terrain shading empties so the labels clamped to the ground follow Physical relief.
 */

import * as Cesium from 'cesium';
import {
  Cartesian3,
  Cartographic,
  GeographicTilingScheme,
  ImageryLayer,
  ImageryLayerCollection,
  ImageryProvider,
  Rectangle,
  Resource,
} from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cesiumSource,
  FAKE_RECTANGLE,
  fakeProvider,
  imagerySkeletons,
} from './helpers/imagery-fakes';

/** The private members pinned here, which Cesium's type declarations leave out. */
interface TileProviderInternals {
  showTileThisFrame(t: unknown, f: unknown): void;
  _onLayerShownOrHidden(l: unknown, i: number, s: boolean): void;
}
interface ImageryCacheInternals {
  _imageryCache: Record<string, object>;
  getImageryFromCache(
    x: number,
    y: number,
    level: number,
    rectangle: Rectangle,
  ): object;
  removeImageryFromCache(imagery: object): void;
}
const tileProvider = (
  Cesium as unknown as {
    GlobeSurfaceTileProvider: { prototype: TileProviderInternals };
  }
).GlobeSurfaceTileProvider.prototype;

/** A terrain quadtree tile's private cache of ground positions and its clamped positions. */
interface QuadtreeTileInternals {
  readonly customData: Set<{ level: number }>;
  getPositionCacheEntry(c: Cartographic, sse: number): unknown;
  setPositionCacheEntry(c: Cartographic, sse: number, value: unknown): void;
  clearPositionCache(): void;
}
interface TerrainInternals {
  QuadtreeTile: new (options: {
    level: number;
    tilingScheme: GeographicTilingScheme;
    x: number;
    y: number;
  }) => QuadtreeTileInternals;
  QuadtreePrimitive: { prototype: { forEachLoadedTile: unknown } };
  GlobeSurfaceTile: new () => {
    mesh: unknown;
    vertexArray: unknown;
    updateExaggeration(
      tile: QuadtreeTileInternals,
      frameState: object,
      quadtree: object,
    ): void;
  };
}
const terrain = Cesium as unknown as TerrainInternals;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cesium 1.145 internals the draped layers rely on (#483)', () => {
  it('draws no texture of a layer at alpha 0', () => {
    const provider = {
      _debug: { texturesRendered: 0, tilesRendered: 0 },
      _tilesToRenderByTextureCount: [] as unknown[][],
    };
    const tile = {
      data: {
        imagery: [
          { readyImagery: { imageryLayer: { alpha: 0 } } },
          { readyImagery: { imageryLayer: { alpha: 0.5 } } },
        ],
        vertexArray: {},
      },
    };
    tileProvider.showTileThisFrame.call(provider, tile, {});
    expect(provider._tilesToRenderByTextureCount[1]).toEqual([tile]);
    expect(provider._debug.texturesRendered).toBe(1);
  });

  it('frees a hidden layer’s tiles as if it were removed', () => {
    const collection = new ImageryLayerCollection();
    const layer = collection.addImageryProvider(fakeProvider());
    const shown = vi.fn();
    collection.layerShownOrHidden.addEventListener(shown);
    layer.show = false;
    (collection as unknown as { _update(): void })._update();
    expect(shown).toHaveBeenCalledWith(layer, 0, false);
    const removed = vi.fn();
    tileProvider._onLayerShownOrHidden.call(
      { _onLayerAdded: vi.fn(), _onLayerRemoved: removed },
      layer,
      0,
      false,
    );
    expect(removed).toHaveBeenCalledWith(layer, 0);
  });

  it('keeps alpha a plain number that the tile shader reads', () => {
    const layer = new ImageryLayer(fakeProvider(), { alpha: 0.25 });
    expect(layer.alpha).toBe(0.25);
    layer.alpha = 0.6;
    expect(layer.alpha).toBe(0.6);
    expect(cesiumSource('Scene/GlobeSurfaceTileProvider.js')).toMatch(
      /dayTextureAlpha\[numberOfDayTextures\] =\s*imageryLayer\.alpha;/,
    );
  });

  it('caches imagery under JSON [x, y, level] in _imageryCache, each with a texture field', () => {
    const layer = new ImageryLayer(
      fakeProvider(),
    ) as unknown as ImageryCacheInternals;
    const imagery = layer.getImageryFromCache(1, 0, 0, Rectangle.MAX_VALUE);
    const cache = layer._imageryCache;
    expect(Object.keys(cache)).toEqual(['[1,0,0]']);
    expect('texture' in imagery).toBe(true);
    layer.removeImageryFromCache(imagery);
    expect(cache).toEqual({});
  });

  it('makes the first shown layer the base layer, and stretches only its edge texels over tiles outside its rectangle', () => {
    const collection = new ImageryLayerCollection();
    const below = collection.addImageryProvider(fakeProvider());
    below.show = false;
    const clipped = collection.addImageryProvider(fakeProvider(FAKE_RECTANGLE));
    // The level-3 imagery tile at the bounds' nearest corner (30 E, 5 N), stretched over the tile.
    expect(imagerySkeletons(collection, clipped)).toEqual([[9, 3, 3]]);
    expect(clipped.isBaseLayer()).toBe(true);
    below.show = true;
    expect(imagerySkeletons(collection, clipped)).toEqual([]);
    expect([below.isBaseLayer(), clipped.isBaseLayer()]).toEqual([true, false]);
  });

  it('decodes imagery flipped, so a south-first bitmap matches what Cesium uploads', () => {
    const fetchImage = vi
      .spyOn(Resource.prototype, 'fetchImage')
      .mockResolvedValue(undefined);
    void ImageryProvider.loadImage(
      undefined as never,
      'https://example.org/tile.png',
    );
    expect(fetchImage).toHaveBeenCalledWith({
      flipY: true,
      preferImageBitmap: true,
    });
  });

  it('re-clamps the ground after a relief change from each tile’s cached positions, which only clearPositionCache empties', () => {
    const tile = new terrain.QuadtreeTile({
      level: 0,
      tilingScheme: new GeographicTilingScheme(),
      x: 0,
      y: 0,
    });
    const anchor = Cartographic.fromDegrees(-3.464718, 40.090953);
    const picked = new Cartesian3(1, 2, 3); // the ground picked at the old relief
    tile.setPositionCacheEntry(anchor, 2, picked);
    const clamped = { level: 7 }; // a label clamped to this tile's ground
    tile.customData.add(clamped);
    const surfaceTile = new terrain.GlobeSurfaceTile();
    const updateExaggeration = vi.fn();
    surfaceTile.vertexArray = {};
    surfaceTile.mesh = {
      encoding: {
        exaggeration: 6,
        exaggerationRelativeHeight: 0,
        hasGeodeticSurfaceNormals: true,
      },
      updateExaggeration,
    };
    const quadtree = { _tileToUpdateHeights: [] as unknown[] };
    surfaceTile.updateExaggeration(
      tile,
      { verticalExaggeration: 10, verticalExaggerationRelativeHeight: 0 },
      quadtree,
    );
    // The tile is queued to update every clamped position from level -1, and its mesh re-exaggerated,
    expect(quadtree._tileToUpdateHeights).toEqual([tile]);
    expect(clamped.level).toBe(-1);
    expect(updateExaggeration).toHaveBeenCalledWith(10, 0);
    // but its cache still holds the old ground, which the update reads before it picks the mesh.
    expect(tile.getPositionCacheEntry(anchor, 2)).toBe(picked);
    expect(cesiumSource('Scene/QuadtreePrimitive.js')).toMatch(
      /const cachedData = tile\.getPositionCacheEntry\([^)]*\);\s*if \(defined\(cachedData\)\) \{\s*\/\/ cache hit\s*position = cachedData;/,
    );
    tile.clearPositionCache();
    expect(tile.getPositionCacheEntry(anchor, 2)).toBeUndefined();
    // The loaded tiles are reached through the globe's quadtree.
    expect(cesiumSource('Scene/Globe.js')).toMatch(
      /this\._surface = new QuadtreePrimitive\(/,
    );
    expect(typeof terrain.QuadtreePrimitive.prototype.forEachLoadedTile).toBe(
      'function',
    );
  });
});
