/**
 * Atlas imagery layers on the globe: order, readiness, alpha and show (terrain draping design, "Per
 * layer under World Terrain" and "How existing features behave", #483; Atlas design §11).
 *
 * - Order: `ATLAS_IMAGERY_LAYER_ORDER` bottom to top, all above the basemap. A new layer goes
 *   after the last Atlas layer of its rank or lower, else before the first of a higher rank, else
 *   on top, so a newer layer of a name sits above the older one it cross-fades over, and a
 *   basemap that arrives later at index 0 stays below.
 * - Readiness: Cesium loads the tiles of a layer at alpha 0 without drawing them (pinned in
 *   tests/atlas-cesium-internals.test.ts). The layer is ready once `globe.tilesLoaded` holds from
 *   the second frame after the add (the first frame's `preRender` still reads the load queues of
 *   the frame before the add), or `DRAPED_READY_CAP_MS` after it. Each `preRender` requests a
 *   frame until then.
 * - Delivered tiles request a render: worker tiles bypass the RequestScheduler that would.
 * - Destroy removes the layer and destroys its provider, once; the page's drape stats watch the
 *   layer in between.
 *
 * Lazy: only the draped runtime imports this module.
 */

import { ImageryLayer, type ImageryLayerCollection } from 'cesium';

import {
  ATLAS_IMAGERY_LAYER_ORDER,
  type AtlasImageryLayerName,
} from '../../geometry/raster/types';
import type { AddDrapedImageryLayer, DrapedImageryLayer } from '../types';
import { drapeStats } from './drape-stats';

/** A new layer reads ready this long after its add, whether or not the globe has loaded. */
export const DRAPED_READY_CAP_MS = 3_000;

/** Frames after the add before `globe.tilesLoaded` counts. */
const READY_FRAMES = 2;

const names = new WeakMap<ImageryLayer, AtlasImageryLayerName>();

/** The Atlas name of a layer this module added; undefined for any other layer. */
export function drapedLayerName(
  layer: ImageryLayer,
): AtlasImageryLayerName | undefined {
  return names.get(layer);
}

function insertionIndex(
  layers: ImageryLayerCollection,
  name: AtlasImageryLayerName,
): number {
  const rank = ATLAS_IMAGERY_LAYER_ORDER.indexOf(name);
  let lastAtOrBelow = -1;
  let firstAbove = -1;
  for (let index = 0; index < layers.length; index += 1) {
    const other = names.get(layers.get(index));
    if (other === undefined) continue;
    if (ATLAS_IMAGERY_LAYER_ORDER.indexOf(other) <= rank) lastAtOrBelow = index;
    else if (firstAbove === -1) firstAbove = index;
  }
  if (lastAtOrBelow !== -1) return lastAtOrBelow + 1;
  if (firstAbove !== -1) return firstAbove;
  return layers.length;
}

export const addDrapedImageryLayer: AddDrapedImageryLayer = ({
  alpha,
  name,
  provider,
  scene,
}): DrapedImageryLayer => {
  const layer = new ImageryLayer(provider, { alpha });
  names.set(layer, name);
  scene.imageryLayers.add(layer, insertionIndex(scene.imageryLayers, name));
  const unwatch = drapeStats.watchLayer(layer);

  const addedAt = performance.now();
  let frames = 0;
  let ready = false;
  let destroyed = false;

  let removePreRender: (() => void) | null = scene.preRender.addEventListener(
    () => {
      frames += 1;
      if (
        (frames >= READY_FRAMES && scene.globe.tilesLoaded) ||
        performance.now() - addedAt >= DRAPED_READY_CAP_MS
      ) {
        ready = true;
        removePreRender?.();
        removePreRender = null;
        return;
      }
      scene.requestRender();
    },
  );
  const removeTileLoaded = provider.tileLoaded.addEventListener(() =>
    scene.requestRender(),
  );
  scene.requestRender();

  return {
    layer,
    name,
    setAlpha(a: number): void {
      if (destroyed || layer.alpha === a) return;
      layer.alpha = a;
      scene.requestRender();
    },
    setShown(s: boolean): void {
      if (destroyed || layer.show === s) return;
      layer.show = s;
      scene.requestRender();
    },
    isReady: () => ready,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      removePreRender?.();
      removePreRender = null;
      removeTileLoaded();
      unwatch();
      // A destroyed globe has already destroyed its layers with the collection.
      if (!scene.imageryLayers.isDestroyed()) {
        scene.imageryLayers.remove(layer, true);
        scene.requestRender();
      }
      provider.destroy();
    },
  };
};
