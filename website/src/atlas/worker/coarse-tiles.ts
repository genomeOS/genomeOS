/**
 * Level 0–2 raster tiles kept per raster key in the data worker (terrain draping design, "How
 * existing features behave": Worker, and "Performance budget and measurement", #483).
 *
 * Cesium asks for the coarse tiles of every new raster, since its level-0 terrain tiles always load
 * and drape their own imagery, and at production density a coarse tile is the costliest to draw: a
 * level-0 tile holds about 39,000 rows. They do not depend on the camera, so the raster runtime
 * keeps each drawn or empty tile at levels 0 to `COARSE_TILE_MAX_LEVEL` under its raster's key, and
 * a raster prepared again with the same key, after World Terrain is turned off and on or a restyle
 * back, serves them without drawing. A failed tile is never kept.
 *
 * The key is the spec field by field and the identity of each object the raster draws from (the
 * render tier, grid and topology of an artifact raster; the parsed borders), so a tier loaded again
 * is a new key, never a stale tile. Footprint circles enter the key by value.
 *
 * Bounded: at most `COARSE_TILE_BUDGET` drawn tiles (256 × 256 RGBA, 256 KiB each) are kept; past
 * it, the raster key used least recently goes first, all its tiles at once. Kept bytes are never
 * handed out to be transferred: the runtime makes a fresh bitmap from them for every post. Nothing
 * here is stochastic.
 */

import type {
  RasterSpec,
  TileAddress,
  TileRaster,
} from '../geometry/raster/types';

/** The finest level whose tiles are kept. */
export const COARSE_TILE_MAX_LEVEL = 2;
/** Drawn tiles kept across raster keys: 16 MiB of RGBA. */
export const COARSE_TILE_BUDGET = 64;

/** Small integers for the objects rasters draw from, by identity. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identityOf(source: object): number {
  let id = identities.get(source);
  if (id === undefined) {
    id = nextIdentity;
    nextIdentity += 1;
    identities.set(source, id);
  }
  return id;
}

/** `spec`'s cache key: its fields in a fixed order and the identity of each of `sources`, the
 * objects its tiles are drawn from. */
export function rasterKey(
  spec: RasterSpec,
  sources: readonly object[],
): string {
  const from = sources.map(identityOf).join(',');
  switch (spec.layer) {
    case 'surface':
      return [
        'surface',
        from,
        spec.artifactKey,
        spec.gridSha256,
        spec.metric,
        spec.palette,
        spec.geometry,
        spec.cells.supported,
        spec.cells.masked,
        spec.contours,
      ].join('|');
    case 'outlines':
      return [
        'outlines',
        from,
        spec.artifactKey,
        spec.gridSha256,
        spec.metric,
        spec.palette,
        spec.geometry,
        spec.edgeColor.mode,
        spec.edgeColor.mode === 'fixed' ? spec.edgeColor.color : '',
      ].join('|');
    case 'borders':
      return ['borders', from, spec.color, spec.maximumLevel].join('|');
    case 'footprints':
      return [
        'footprints',
        from,
        spec.artifactKey,
        spec.color,
        Array.prototype.join.call(spec.circles, ','),
      ].join('|');
  }
}

export interface CoarseTiles {
  /** The tile kept under `key` at `a`: its raster, null when it is empty, undefined when none is
   * kept (always for a tile finer than `COARSE_TILE_MAX_LEVEL`). */
  get(key: string, a: TileAddress): TileRaster | null | undefined;
  /** Keeps a drawn or empty tile at a coarse level; a finer one is not kept. */
  keep(key: string, a: TileAddress, tile: TileRaster | null): void;
}

export function createCoarseTiles(budget = COARSE_TILE_BUDGET): CoarseTiles {
  /** Tiles per raster key, least recently used key first. */
  const byKey = new Map<string, Map<string, TileRaster | null>>();
  let drawn = 0;

  const tileKey = (a: TileAddress) => `${a.level}/${a.x}/${a.y}`;

  /** The key's tiles, moved to the most recently used end. */
  function touch(key: string): Map<string, TileRaster | null> | undefined {
    const tiles = byKey.get(key);
    if (tiles) {
      byKey.delete(key);
      byKey.set(key, tiles);
    }
    return tiles;
  }

  function evict(): void {
    for (const [key, tiles] of byKey) {
      if (drawn <= budget) return;
      byKey.delete(key);
      for (const tile of tiles.values()) if (tile) drawn -= 1;
    }
  }

  return {
    get(key, a) {
      if (a.level > COARSE_TILE_MAX_LEVEL) return undefined;
      return touch(key)?.get(tileKey(a));
    },
    keep(key, a, tile) {
      if (a.level > COARSE_TILE_MAX_LEVEL) return;
      let tiles = touch(key);
      if (!tiles) {
        tiles = new Map();
        byKey.set(key, tiles);
      }
      const at = tileKey(a);
      if (tiles.get(at)) drawn -= 1;
      tiles.set(at, tile);
      if (tile) drawn += 1;
      evict();
    },
  };
}
