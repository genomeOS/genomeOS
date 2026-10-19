/**
 * `renderedImageryLoaded`: whether the tiles the globe rendered carry one Atlas imagery layer's
 * imagery, loaded (terrain draping design, "How existing features behave" and "Performance budget
 * and measurement", #483; Atlas design §11). A draped layer is ready by this rule, not by
 * `globe.tilesLoaded`, which waits on every load queue: terrain refinement, the basemap, the other
 * Atlas layers and tiles no frame draws.
 *
 * It reads Cesium 1.145 internals, pinned in tests/atlas-cesium-internals.test.ts: the globe's
 * quadtree (`Globe._surface`) keeps the tiles its last frame rendered in `_tilesToRender`, and each
 * terrain tile keeps, per imagery tile of each shown layer that covers it, a `TileImagery` whose
 * `loadingImagery` is the imagery tile it asked for until that tile is ready, and then none (an
 * ancestor's imagery it draws meanwhile is its `readyImagery`). A layer that has not loaded its
 * provider holds a placeholder imagery of its own there. A rendered tile the layer does not cover
 * has no imagery of it and does not count; with no tile rendered, as right after a terrain change,
 * nothing has loaded. Internals that are not where the pin says throw rather than read as loaded.
 *
 * Lazy: only `draped-imagery-layer.ts` imports this module.
 */

import type { Globe, ImageryLayer } from 'cesium';

/** The members of a terrain tile's `TileImagery` read here. */
interface TileImageryInternals {
  readonly loadingImagery?: { readonly imageryLayer: ImageryLayer };
}

/** The members of a rendered terrain tile read here: its `GlobeSurfaceTile`'s imagery. */
interface RenderedTileInternals {
  readonly data?: { readonly imagery?: readonly TileImageryInternals[] };
}

function renderedTiles(globe: Globe): readonly RenderedTileInternals[] {
  const tiles = (
    globe as unknown as {
      _surface?: { _tilesToRender?: readonly RenderedTileInternals[] };
    }
  )._surface?._tilesToRender;
  if (!Array.isArray(tiles))
    throw new Error(
      'Globe._surface._tilesToRender is missing: the Cesium internals pin no longer holds',
    );
  return tiles;
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
