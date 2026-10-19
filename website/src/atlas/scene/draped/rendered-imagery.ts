/**
 * What the globe's last frame rendered, read for a draped layer's readiness (terrain draping
 * design, "How existing features behave" and "Performance budget and measurement", #483; Atlas
 * design §11). A draped layer is ready by these rules, not by `globe.tilesLoaded`, which waits on
 * every load queue: terrain refinement, the basemap, the other Atlas layers and tiles no frame
 * draws.
 *
 * - `renderedTilesSettled`: the rendered tiles are the ones the globe chose for the view, not
 *   coarser stand-ins drawn while finer terrain loads. Right after a terrain change the globe
 *   draws its two level-0 tiles for a while, and those carry a layer's coarsest imagery long
 *   before the tiles the view settles on carry theirs; a layer read ready then would fade in, and
 *   pre-warm its shaders, over tiles about to be replaced. Not settled while a tile blocks
 *   refinement as it loads (the quadtree's high-priority load queue), while a tile is drawn in
 *   place of descendants that cannot render yet (`_debug.tilesWaitingForChildren`, which Cesium
 *   counts whatever its debug output; those descendants load at medium priority, so the high
 *   queue alone would read settled), or while a rendered tile is a fill, its own terrain not yet
 *   loaded.
 * - `renderedImageryLoaded`: those tiles carry one Atlas imagery layer's imagery, loaded.
 * - `deepestRenderedLevel`: the deepest level rendered, for the e2e build's readiness measure.
 *
 * It reads Cesium 1.145 internals, pinned in tests/atlas-cesium-internals.test.ts: the globe's
 * quadtree (`Globe._surface`) keeps the tiles its last frame rendered in `_tilesToRender`, and the
 * load queues and counts of its selection until the next render frame begins, so `preRender`
 * reads the frame before. Each terrain tile keeps, per imagery tile of each shown layer that
 * covers it, a `TileImagery` whose `loadingImagery` is the imagery tile it asked for until that
 * tile is ready, and then none (an ancestor's imagery it draws meanwhile is its `readyImagery`). A
 * layer that has not loaded its provider holds a placeholder imagery of its own there. An imagery
 * tile that failed (or that a discard policy rejected) stays `loadingImagery`, so the layer reads
 * not loaded until `DRAPED_READY_CAP_MS`: no silent gap, since each Atlas provider raises
 * `errorEvent` for a failed tile and its owner reverts the scene to the smooth globe (`onError`).
 * A rendered tile the layer does not cover has no imagery of it and does not count; with no tile
 * rendered, as right after a terrain change, nothing has loaded. Internals that are not where the
 * pin says throw rather than read as loaded or settled.
 *
 * Lazy: only `draped-imagery-layer.ts` imports this module.
 */

import type { Globe, ImageryLayer } from 'cesium';

/** The members of a terrain tile's `TileImagery` read here. */
interface TileImageryInternals {
  readonly loadingImagery?: { readonly imageryLayer: ImageryLayer };
}

/** The members of a rendered tile (a `QuadtreeTile`, its `GlobeSurfaceTile` as data) read here. */
interface RenderedTileInternals {
  readonly data?: { readonly imagery?: readonly TileImageryInternals[] };
  readonly level: number;
  readonly renderable?: boolean;
}

/** The members of the globe's quadtree read here, as its last render frame left them. */
interface QuadtreeInternals {
  readonly _tilesToRender?: readonly RenderedTileInternals[];
  readonly _tileLoadQueueHigh?: readonly unknown[];
  readonly _debug?: { readonly tilesWaitingForChildren?: number };
}

function quadtree(globe: Globe): QuadtreeInternals {
  return (globe as unknown as { _surface?: QuadtreeInternals })._surface ?? {};
}

function renderedTiles(globe: Globe): readonly RenderedTileInternals[] {
  const tiles = quadtree(globe)._tilesToRender;
  if (!Array.isArray(tiles))
    throw new Error(
      'Globe._surface._tilesToRender is missing: the Cesium internals pin no longer holds',
    );
  return tiles;
}

/**
 * True when the globe's last frame rendered the tiles it chose for the view: none blocked
 * refinement while it loaded, none stood in for descendants still loading, and each had its own
 * terrain.
 */
export function renderedTilesSettled(globe: Globe): boolean {
  const tiles = renderedTiles(globe);
  const { _debug: debug, _tileLoadQueueHigh: blockers } = quadtree(globe);
  const waiting = debug?.tilesWaitingForChildren;
  if (!Array.isArray(blockers) || typeof waiting !== 'number')
    throw new Error(
      'Globe._surface._tileLoadQueueHigh or _debug.tilesWaitingForChildren is missing: ' +
        'the Cesium internals pin no longer holds',
    );
  if (blockers.length > 0 || waiting > 0) return false;
  for (const tile of tiles) {
    if (typeof tile.renderable !== 'boolean')
      throw new Error(
        'A rendered tile has no renderable flag: the Cesium internals pin no longer holds',
      );
    if (!tile.renderable) return false;
  }
  return true;
}

/**
 * True when the globe's last frame rendered at least one tile, and no rendered tile is still
 * loading imagery of `layer`: every one it covers has its own imagery tiles of the layer ready.
 */
export function renderedImageryLoaded(
  globe: Globe,
  layer: ImageryLayer,
): boolean {
  const tiles = renderedTiles(globe);
  if (tiles.length === 0) return false;
  for (const tile of tiles) {
    const imagery = tile.data?.imagery;
    if (!Array.isArray(imagery))
      throw new Error(
        'A rendered tile has no imagery list: the Cesium internals pin no longer holds',
      );
    for (const entry of imagery)
      if (entry.loadingImagery?.imageryLayer === layer) return false;
  }
  return true;
}

/** The deepest level among the tiles the globe's last frame rendered; −1 with none. */
export function deepestRenderedLevel(globe: Globe): number {
  let deepest = -1;
  for (const tile of renderedTiles(globe))
    deepest = Math.max(deepest, tile.level);
  return deepest;
}
