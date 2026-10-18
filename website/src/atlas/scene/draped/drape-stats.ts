/**
 * Drape statistics for the World Terrain budgets (terrain draping design, "Performance budget and
 * measurement", #483; Atlas design §11): tile counts through the raster source, a raster-time
 * histogram of tiles at level 3 and finer, and resident Atlas imagery bytes, read from the pinned
 * `ImageryLayer._imageryCache` (tests/atlas-cesium-internals.test.ts). Neither falls back
 * silently: a tile whose raster time is not a finite, non-negative duration rejects (its bitmap
 * closed), and a watched layer without the cache throws on `read`. The e2e build publishes the
 * page's recorder as `__atlasDrapeStats`. Lazy: only the draped runtime imports this module.
 */

import type { ImageryLayer } from 'cesium';

import {
  OUTLINE_MIN_LEVEL,
  RASTER_TILE_SIZE,
  RESIDENT_TILE_BYTES,
} from '../../geometry/raster/types';
import type { RasterTileMessage } from '../../worker/protocol';
import type {
  DrapeStats,
  DrapeStatsRecorder,
  RasterTileSource,
} from '../types';

/** Upper bounds (ms, inclusive) of the raster-time bins; the last catches every finite rest. */
export const DRAPE_RASTER_BINS_MS = [0.5, 1, 2, 4, 8, 16, Infinity] as const;

/** The members of a cached imagery tile this module reads. */
interface CachedImagery {
  texture?: { width: number };
}

function cachedImagery(layer: ImageryLayer): Iterable<CachedImagery> {
  const cache = (
    layer as unknown as { _imageryCache?: Record<string, CachedImagery> }
  )._imageryCache;
  if (cache === undefined)
    throw new Error(
      'ImageryLayer._imageryCache is missing: the Cesium internals pin no longer holds',
    );
  return Object.values(cache);
}

/** A worker timing the histogram can bin: finite and non-negative. */
function checkRasterMs(message: RasterTileMessage): void {
  const { level, rasterMs, x, y } = message;
  if (Number.isFinite(rasterMs) && rasterMs >= 0) return;
  message.bitmap?.close();
  throw new RangeError(
    `Raster tile ${x}/${y}/${level} reports ${rasterMs} ms, not a duration`,
  );
}

/** The first bin whose upper bound is at or above `rasterMs`, a checked duration. */
function bin(rasterMs: number): number {
  return DRAPE_RASTER_BINS_MS.findIndex((upper) => rasterMs <= upper);
}

/** A recorder of its own; the page shares `drapeStats`. */
export function createDrapeStats(): DrapeStatsRecorder {
  let requested = 0;
  let delivered = 0;
  let empty = 0;
  let queueDepth = 0;
  const counts = DRAPE_RASTER_BINS_MS.map(() => 0);
  const layers = new Set<ImageryLayer>();

  return {
    source(inner: RasterTileSource): RasterTileSource {
      return {
        prepare: (spec, signal) => inner.prepare(spec, signal),
        release: (id) => inner.release(id),
        async tile(body) {
          requested += 1;
          queueDepth += 1;
          try {
            const message = await inner.tile(body);
            checkRasterMs(message);
            delivered += 1;
            if (message.bitmap === null) empty += 1;
            if (message.level >= OUTLINE_MIN_LEVEL)
              counts[bin(message.rasterMs)] += 1;
            return message;
          } finally {
            queueDepth -= 1;
          }
        },
      };
    },
    watchLayer(layer: ImageryLayer): () => void {
      layers.add(layer);
      return () => {
        layers.delete(layer);
      };
    },
    read(): DrapeStats {
      let resident = 0;
      for (const layer of layers)
        for (const imagery of cachedImagery(layer))
          if (imagery.texture?.width === RASTER_TILE_SIZE) resident += 1;
      return {
        delivered,
        empty,
        queueDepth,
        rasterMs: { counts: [...counts], upperMs: DRAPE_RASTER_BINS_MS },
        requested,
        residentBytes: resident * RESIDENT_TILE_BYTES,
      };
    },
  };
}

/** The page's recorder: `addDrapedImageryLayer` watches every Atlas layer with it. */
export const drapeStats: DrapeStatsRecorder = createDrapeStats();
