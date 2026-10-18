/**
 * `drapedRuntime`, the lazy entry point of the draped Atlas layers (terrain draping design, "When it
 * is active" and "Per layer under World Terrain", #483; Atlas design §11).
 *
 * Main-thread code reaches the draped modules only through `import()` of this module, and outside
 * them imports only their types; the `'atlas-draped-v1'` marker shows where this chunk ends up,
 * and no /app/ initial chunk may contain it. The runtime hands out the draped surface group, the
 * imagery-layer adder, a provider for any raster spec (so the borders and footprints never import
 * the provider class statically), the page's drape stats, and a raster source over the worker
 * client whose tiles those stats count.
 */

import type {
  DrapedRuntime,
  RasterTileSource,
  RasterWorkerClient,
} from '../types';
import { drapeStats } from './drape-stats';
import { addDrapedImageryLayer } from './draped-imagery-layer';
import { createDrapedSurfaceGroup } from './draped-surface-group';
import { AtlasRasterImageryProvider } from './raster-imagery-provider';

/** The worker client's raster requests as a tile source, counted by the page's drape stats. */
function rasterSource(w: RasterWorkerClient): RasterTileSource {
  return drapeStats.source({
    prepare: (s, signal) => w.prepareRaster(s, signal),
    release(id) {
      // Fire and forget, as Cesium destroys a provider; a failed release is still reported.
      w.releaseRaster(id).catch((error: unknown) => {
        console.warn(
          `Atlas raster ${id} could not be released in the worker.`,
          error,
        );
      });
    },
    tile: (b) => w.rasterTile(b),
  });
}

export const drapedRuntime: DrapedRuntime = {
  addDrapedImageryLayer,
  createDrapedSurfaceGroup,
  providerFromSpec: (src, spec, signal) =>
    AtlasRasterImageryProvider.fromSpec(src, spec, signal),
  rasterSource,
  stats: drapeStats,
  version: 'atlas-draped-v1',
};
