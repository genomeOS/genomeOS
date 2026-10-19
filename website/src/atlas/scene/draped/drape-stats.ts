/**
 * Drape statistics for the World Terrain budgets (terrain draping design, "Performance budget and
 * measurement", #483; Atlas design §11): tile counts through the raster source, a raster-time
 * histogram of tiles at level 3 and finer (the budget's), and resident Atlas imagery bytes, read
 * from the pinned `ImageryLayer._imageryCache` (tests/atlas-cesium-internals.test.ts). Beside the
 * budget, for the tour that attributes its timings: the raster time of the coarse tiles (levels
 * 0–2) in a histogram of their own, so the budget's keeps its meaning, and each tile's time from
 * request to delivery, binned per level. None falls back silently: a tile whose raster time is not
 * a finite, non-negative duration, or whose level is outside 0–`RASTER_MAX_LEVEL`, rejects (its
 * bitmap closed), and a watched layer without the cache throws on `read`. The e2e build publishes
 * the page's recorder as `__atlasDrapeStats`. Lazy: only the draped modules (`scene/draped/*`)
 * import this module.
 */

import type { ImageryLayer } from 'cesium';

import {
  OUTLINE_MIN_LEVEL,
  RASTER_MAX_LEVEL,
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

/** Upper bounds (ms, inclusive) of the request-to-delivery bins, doubling from 8 ms. */
export const DRAPE_DELIVERY_BINS_MS = [
  8,
  16,
  32,
  64,
  128,
  256,
  512,
  1_024,
  2_048,
  4_096,
  Infinity,
] as const;

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

/**
 * A worker tile the histograms can bin: a raster time that is finite and non-negative, at a level
 * from 0 to `RASTER_MAX_LEVEL`.
 */
function checkTile(message: RasterTileMessage): void {
  const { level, rasterMs, x, y } = message;
  const timed = Number.isFinite(rasterMs) && rasterMs >= 0;
  const levelled =
    Number.isInteger(level) && level >= 0 && level <= RASTER_MAX_LEVEL;
  if (timed && levelled) return;
  message.bitmap?.close();
  throw new RangeError(
    timed
      ? `Raster tile ${x}/${y}/${level} is outside levels 0–${RASTER_MAX_LEVEL}`
      : `Raster tile ${x}/${y}/${level} reports ${rasterMs} ms, not a duration`,
  );
}

/** The first bin of `bins` whose upper bound is at or above `ms`, a checked duration. */
function bin(bins: readonly number[], ms: number): number {
  return bins.findIndex((upper) => ms <= upper);
}

/**
 * A recorder of its own; the page shares `drapeStats`. `now` is the clock a tile's request and
 * delivery are read on.
 */
export function createDrapeStats(
  now: () => number = () => performance.now(),
): DrapeStatsRecorder {
  let requested = 0;
  let delivered = 0;
  let empty = 0;
  let queueDepth = 0;
  const counts = DRAPE_RASTER_BINS_MS.map(() => 0);
  const coarseCounts = DRAPE_RASTER_BINS_MS.map(() => 0);
  const deliveryCounts = Array.from({ length: RASTER_MAX_LEVEL + 1 }, () =>
    DRAPE_DELIVERY_BINS_MS.map(() => 0),
  );
  const layers = new Set<ImageryLayer>();

  return {
    source(inner: RasterTileSource): RasterTileSource {
      return {
        prepare: (spec, signal) => inner.prepare(spec, signal),
        release: (id) => inner.release(id),
        async tile(body) {
          const requestedAt = now();
          requested += 1;
          queueDepth += 1;
          try {
            const message = await inner.tile(body);
            checkTile(message);
            delivered += 1;
            if (message.bitmap === null) empty += 1;
            const raster = bin(DRAPE_RASTER_BINS_MS, message.rasterMs);
            if (message.level >= OUTLINE_MIN_LEVEL) counts[raster] += 1;
            else coarseCounts[raster] += 1;
            deliveryCounts[message.level][
              bin(DRAPE_DELIVERY_BINS_MS, now() - requestedAt)
            ] += 1;
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
        coarseRasterMs: {
          counts: [...coarseCounts],
          upperMs: DRAPE_RASTER_BINS_MS,
        },
        delivered,
        deliveryMs: {
          byLevel: deliveryCounts.map((level) => [...level]),
          upperMs: DRAPE_DELIVERY_BINS_MS,
        },
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
