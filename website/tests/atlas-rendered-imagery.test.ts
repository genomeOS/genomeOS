/**
 * `renderedImageryLoaded`: whether the tiles the globe rendered carry one layer's imagery, loaded;
 * `renderedTilesSettled`: whether they are the tiles the globe chose for the view, not coarser ones
 * drawn while finer terrain loads (terrain draping design, "How existing features behave", #483).
 * The tiles are Cesium's own imagery skeletons (`ImageryLayer._createTileImagerySkeletons`) and
 * state machine, and the quadtree's load state is where Cesium keeps it; the members are pinned
 * in tests/atlas-cesium-internals.test.ts.
 */

import * as Cesium from 'cesium';
import {
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  ImageryLayerCollection,
  type Globe,
  type ImageryLayer,
} from 'cesium';
import { describe, expect, it } from 'vitest';

import {
  deepestRenderedLevel,
  renderedImageryLoaded,
  renderedTilesSettled,
} from '../src/atlas/scene/draped/rendered-imagery';
import { FAKE_RECTANGLE, fakeProvider } from './helpers/imagery-fakes';

interface ImageryInternals {
  imageryLayer: ImageryLayer;
  parent?: ImageryInternals;
  state: number;
  texture?: unknown;
}
interface TileImageryInternals {
  readyImagery?: ImageryInternals;
  loadingImagery?: ImageryInternals;
  processStateMachine(
    tile: unknown,
    frameState: object,
    skip: boolean,
  ): boolean;
}
interface TerrainTile {
  data: { imagery: TileImageryInternals[] };
  level: number;
  rectangle: Cesium.Rectangle;
  /** Its own terrain is loaded; else Cesium draws it as a fill. */
  renderable: boolean;
  x: number;
  y: number;
}
const { ImageryState } = Cesium as unknown as {
  ImageryState: { FAILED: number; READY: number };
};

const TILING = new GeographicTilingScheme();

/**
 * A terrain tile at `x`, `y`, `level` as Cesium prepares a new one: each shown layer of `layers`
 * that covers it, bottom to top, gives it imagery that is loading.
 */
function terrainTile(
  layers: ImageryLayerCollection,
  x: number,
  y: number,
  level: number,
): TerrainTile {
  (layers as unknown as { _update(): void })._update();
  const tile: TerrainTile = {
    data: { imagery: [] },
    level,
    rectangle: TILING.tileXYToRectangle(x, y, level),
    renderable: true,
    x,
    y,
  };
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers.get(i);
    if (!layer.show) continue;
    (
      layer as unknown as {
        _createTileImagerySkeletons(t: unknown, terrain: unknown): boolean;
      }
    )._createTileImagerySkeletons(tile, new EllipsoidTerrainProvider());
  }
  return tile;
}

/** Cesium's state machine runs on `tile` once its imagery tiles of `layer` (or of every layer) are made. */
function load(tile: TerrainTile, layer?: ImageryLayer): void {
  for (const entry of tile.data.imagery) {
    const imagery = entry.loadingImagery;
    if (!imagery || (layer && imagery.imageryLayer !== layer)) continue;
    imagery.state = ImageryState.READY;
    imagery.texture = {};
    entry.processStateMachine(tile, {}, true);
  }
}

/**
 * A globe whose last frame rendered `tiles`, with `blockers` tiles that blocked refinement while
 * they loaded and `waiting` tiles drawn in place of descendants still loading (none by default).
 */
function globeRendering(
  tiles: TerrainTile[],
  { blockers = 0, waiting = 0 } = {},
): Globe {
  return {
    _surface: {
      _debug: { tilesWaitingForChildren: waiting },
      _tileLoadQueueHigh: tiles.slice(0, blockers),
      _tilesToRender: tiles,
    },
    tilesLoaded: false,
  } as unknown as Globe;
}

/** A basemap at the bottom (the base layer), and an Atlas-like layer clipped to `FAKE_RECTANGLE`. */
function layers() {
  const collection = new ImageryLayerCollection();
  const basemap = collection.addImageryProvider(fakeProvider());
  const atlas = collection.addImageryProvider(fakeProvider(FAKE_RECTANGLE));
  return { atlas, basemap, collection };
}

describe('renderedImageryLoaded (#483)', () => {
  // FAKE_BOUNDS (30..40 E, 5 S..5 N) lies within the level-3 tiles x 9, y 3 and y 4.
  it('reads loaded once every rendered tile has the layer’s imagery, whatever the globe still loads', () => {
    const { atlas, basemap, collection } = layers();
    const north = terrainTile(collection, 9, 3, 3);
    const south = terrainTile(collection, 9, 4, 3);
    const globe = globeRendering([north, south]);
    expect(renderedImageryLoaded(globe, atlas)).toBe(false);
    load(north, atlas);
    expect(renderedImageryLoaded(globe, atlas)).toBe(false);
    load(south, atlas);
    // The basemap still loads on both tiles, and the globe's load queues are not empty.
    expect(renderedImageryLoaded(globe, atlas)).toBe(true);
    expect(renderedImageryLoaded(globe, basemap)).toBe(false);
    load(north);
    load(south);
    expect(renderedImageryLoaded(globe, basemap)).toBe(true);
  });

  it('is not loaded while a rendered tile draws an ancestor’s imagery of the layer in place of its own', () => {
    const { atlas, collection } = layers();
    const tile = terrainTile(collection, 9, 3, 3);
    const [, entry] = tile.data.imagery;
    const own = entry.loadingImagery!;
    expect(own.imageryLayer).toBe(atlas);
    own.parent!.state = ImageryState.READY;
    own.parent!.texture = {};
    entry.processStateMachine(tile, {}, true);
    expect(entry.readyImagery).toBe(own.parent);
    expect(renderedImageryLoaded(globeRendering([tile]), atlas)).toBe(false);
    load(tile, atlas);
    expect(renderedImageryLoaded(globeRendering([tile]), atlas)).toBe(true);
  });

  // Cesium keeps a failed imagery tile (or one a discard policy rejects) as the tile's
  // `loadingImagery`, done with the ancestor it draws. The layer then stays not ready until the
  // cap: the provider's `errorEvent`, which reverts the scene to the smooth globe, answers it.
  it('is not loaded while a rendered tile’s own imagery of the layer failed', () => {
    const { atlas, collection } = layers();
    const tile = terrainTile(collection, 9, 3, 3);
    const [, entry] = tile.data.imagery;
    const own = entry.loadingImagery!;
    own.parent!.state = ImageryState.READY;
    own.parent!.texture = {};
    own.state = ImageryState.FAILED;
    expect(entry.processStateMachine(tile, {}, true)).toBe(true);
    expect(entry.loadingImagery).toBe(own);
    expect(entry.readyImagery).toBe(own.parent);
    expect(renderedImageryLoaded(globeRendering([tile]), atlas)).toBe(false);
  });

  it('leaves out a rendered tile the layer does not cover', () => {
    const { atlas, collection } = layers();
    const inside = terrainTile(collection, 9, 3, 3);
    const outside = terrainTile(collection, 2, 1, 3);
    expect(
      outside.data.imagery.map((entry) => entry.loadingImagery!.imageryLayer),
    ).not.toContain(atlas);
    load(inside, atlas);
    expect(
      renderedImageryLoaded(globeRendering([inside, outside]), atlas),
    ).toBe(true);
  });

  // Right after a terrain change, nothing renders until the new level-0 tiles have loaded.
  it('is not loaded while the globe renders no tile', () => {
    const { atlas } = layers();
    expect(renderedImageryLoaded(globeRendering([]), atlas)).toBe(false);
  });

  it('fails loudly when the globe’s rendered tiles are not where Cesium 1.145 keeps them', () => {
    const { atlas } = layers();
    expect(() =>
      renderedImageryLoaded({ tilesLoaded: true } as unknown as Globe, atlas),
    ).toThrow(/_tilesToRender is missing/);
    expect(() =>
      renderedImageryLoaded(
        globeRendering([{} as unknown as TerrainTile]),
        atlas,
      ),
    ).toThrow(/rendered tile has no imagery/);
  });
});

describe('renderedTilesSettled (#483)', () => {
  const tiles = () => {
    const { collection } = layers();
    return [terrainTile(collection, 9, 3, 3), terrainTile(collection, 9, 4, 3)];
  };

  it('is settled once the frame drew the tiles it chose for the view, each with its own terrain', () => {
    expect(renderedTilesSettled(globeRendering(tiles()))).toBe(true);
  });

  // Right after a terrain change the globe draws its two level-0 tiles while they load what
  // refining them needs: Cesium queues them as refinement blockers, at high priority.
  it('is not settled while a rendered tile blocks refinement as it loads', () => {
    const rendered = tiles();
    expect(
      renderedTilesSettled(globeRendering(rendered, { blockers: 2 })),
    ).toBe(false);
  });

  // A tile refined into children that cannot render yet, none of them drawn last frame, is drawn
  // in their place while they load at medium priority: no refinement blocker then.
  it('is not settled while a rendered tile stands in for descendants that still load', () => {
    expect(renderedTilesSettled(globeRendering(tiles(), { waiting: 1 }))).toBe(
      false,
    );
  });

  // A newly visible tile beside ones drawn last frame is drawn as a fill until its terrain loads.
  it('is not settled while a rendered tile is a fill, its own terrain not loaded', () => {
    const rendered = tiles();
    rendered[1].renderable = false;
    expect(renderedTilesSettled(globeRendering(rendered))).toBe(false);
  });

  it('fails loudly when the quadtree’s load state is not where Cesium 1.145 keeps it', () => {
    const rendered = tiles();
    expect(() =>
      renderedTilesSettled({
        _surface: { _tilesToRender: rendered },
      } as unknown as Globe),
    ).toThrow(
      /_tileLoadQueueHigh or _debug\.tilesWaitingForChildren is missing/,
    );
    const unflagged = { ...rendered[0], renderable: undefined };
    expect(() =>
      renderedTilesSettled(
        globeRendering([unflagged as unknown as TerrainTile]),
      ),
    ).toThrow(/rendered tile has no renderable flag/);
  });
});

describe('deepestRenderedLevel (#483)', () => {
  it('is the deepest level the globe’s last frame rendered, −1 with none', () => {
    const { collection } = layers();
    expect(
      deepestRenderedLevel(
        globeRendering([
          terrainTile(collection, 0, 0, 0),
          terrainTile(collection, 9, 3, 3),
          terrainTile(collection, 4, 1, 2),
        ]),
      ),
    ).toBe(3);
    expect(deepestRenderedLevel(globeRendering([]))).toBe(-1);
  });
});
