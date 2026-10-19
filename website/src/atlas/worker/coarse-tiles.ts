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
 * The key is every field of the spec, by name in sorted order and a typed array such as the
 * footprint circles by value, so a field added to a spec enters it unasked; and the identity of
 * each object the raster draws from (the render tier, grid and topology of an artifact raster; the
 * parsed borders), so a tier loaded again is a new key, never a stale tile. A field whose value
 * cannot be told apart by value (a function, a symbol, a class instance such as a Map) is refused,
 * never left out.
 *
 * Bounded per layer kind: the runtime keeps one cache per kind, each of at most
 * `COARSE_TILE_BUDGET` drawn tiles (256 × 256 RGBA, 256 KiB each), every level 0–2 tile of one
 * raster, and at most `COARSE_TILE_MAX_KEYS` raster keys, those whose kept tiles are all empty
 * too (an outline raster draws nothing below level 3, yet Cesium asks for its coarse tiles). So
 * the newest raster of each kind keeps all its coarse tiles whatever the view asked for, and
 * restyles of one kind never drop another's. Past either bound, the kind's raster key used least
 * recently goes first, all its tiles at once. At production density one raster of each kind
 * draws 36 surface, 42 border and 26 footprint tiles at levels 0–2 and no outline tile, 26 MiB in
 * all; 31.5 MiB is the bound while outlines draw none there. Kept bytes are never handed out to be
 * transferred: the runtime makes a fresh bitmap from them for every post. Nothing here is
 * stochastic.
 */

import type {
  RasterSpec,
  TileAddress,
  TileRaster,
} from '../geometry/raster/types';

/** The finest level whose tiles are kept. */
export const COARSE_TILE_MAX_LEVEL = 2;
/** Drawn tiles kept per layer kind: every level 0–2 tile of one raster, 2 + 8 + 32, 10.5 MiB of
 * RGBA. */
export const COARSE_TILE_BUDGET = 42;

/** Raster keys kept per layer kind, drawn tiles or not. */
export const COARSE_TILE_MAX_KEYS = 16;

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

/** `value` as text that is equal for equal values: a plain object's fields by name in sorted
 * order, a typed array by value. `at` names the field in the error any other value throws. */
function keyText(value: unknown, at: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  )
    return String(value);
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView))
      return `${value.constructor.name}[${Array.prototype.join.call(value, ',')}]`;
    if (Array.isArray(value))
      return `[${value.map((item, k) => keyText(item, `${at}[${k}]`)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === Object.prototype || prototype === null) {
      const fields = value as Record<string, unknown>;
      const text = Object.keys(fields)
        .sort()
        .map((name) => {
          const path = at === '' ? name : `${at}.${name}`;
          return `${JSON.stringify(name)}:${keyText(fields[name], path)}`;
        });
      return `{${text.join(',')}}`;
    }
  }
  const kind =
    typeof value === 'object' ? value.constructor.name : typeof value;
  throw new Error(
    `raster spec field ${at} is a ${kind}, which a coarse-tile key cannot hold by value`,
  );
}

/** `spec`'s cache key: every field of it, and the identity of each of `sources`, the objects its
 * tiles are drawn from. */
export function rasterKey(
  spec: RasterSpec,
  sources: readonly object[],
): string {
  return `${sources.map(identityOf).join(',')}|${keyText(spec, '')}`;
}

/** One layer kind's kept coarse tiles. */
export interface CoarseTiles {
  /** The tile kept under `key` at `a`: its raster, null when it is empty, undefined when none is
   * kept (always for a tile finer than `COARSE_TILE_MAX_LEVEL`). */
  get(key: string, a: TileAddress): TileRaster | null | undefined;
  /** Keeps a drawn or empty tile at a coarse level; a finer one is not kept. */
  keep(key: string, a: TileAddress, tile: TileRaster | null): void;
}

export function createCoarseTiles(
  budget = COARSE_TILE_BUDGET,
  maxKeys = COARSE_TILE_MAX_KEYS,
): CoarseTiles {
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
      if (drawn <= budget && byKey.size <= maxKeys) return;
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
