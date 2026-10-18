/**
 * Atlas imagery layers on the globe: order, readiness, alpha and show (terrain draping design, "Per
 * layer under World Terrain" and "How existing features behave", #483; Atlas design §11).
 *
 * - Order: `ATLAS_IMAGERY_LAYER_ORDER` bottom to top, all above the basemap. A new layer goes
 *   after the last Atlas layer of its rank or lower, else before the first of a higher rank, else
 *   on top, so a newer layer of a name sits above the older one it cross-fades over, and a
 *   basemap that arrives later at index 0 stays below.
 * - Base guard: Cesium makes the first shown layer of a collection the base layer, and stretches
 *   the base layer's edge texels over every terrain tile outside its rectangle (pinned in
 *   tests/atlas-cesium-internals.test.ts). The Atlas providers are clipped to their drawn bounds,
 *   so with the basemap hidden (Context off) or not yet loaded, `atlas-surface` would smear its
 *   edge across the globe and ask the worker for its edge tiles under every terrain tile. While
 *   any Atlas layer is on a collection, one shown whole-globe guard layer at alpha 0 sits directly
 *   below them: it is the base layer whenever no shown layer lies under it, its two level-0 tiles
 *   are the shared empty canvas, and at alpha 0 it draws nothing (also pinned). It goes with the
 *   last Atlas layer.
 * - Readiness: Cesium loads the tiles of a layer at alpha 0 without drawing them, and frees every
 *   tile of a hidden one (both pinned in tests/atlas-cesium-internals.test.ts). The layer is ready
 *   once `globe.tilesLoaded` holds from the second frame after it was added or last shown (the
 *   first frame's `preRender` still reads the load queues of the frame before), or
 *   `DRAPED_READY_CAP_MS` after that. Each `preRender` requests a frame until then. A hidden layer
 *   is never ready and requests no frame; shown again, its readiness starts over.
 * - Delivered tiles request a render: worker tiles bypass the RequestScheduler that would.
 * - Destroy removes the layer and destroys its provider, once; the page's drape stats watch the
 *   layer in between.
 *
 * Lazy: only the draped modules (`scene/draped/*`) import this module, and the e2e build's terrain
 * probe (`scene/synthetic-terrain.ts`, itself imported only dynamically and never by a production
 * build), which names the layers with `drapedLayerName`.
 */

import {
  Event,
  GeographicTilingScheme,
  ImageryLayer,
  Rectangle,
  type Credit,
  type ImageryLayerCollection,
  type ImageryLayerFeatureInfo,
  type ImageryProvider,
  type Proxy as ResourceProxy,
  type TileDiscardPolicy,
} from 'cesium';

import {
  ATLAS_IMAGERY_LAYER_ORDER,
  RASTER_TILE_SIZE,
  type AtlasImageryLayerName,
} from '../../geometry/raster/types';
import type { AddDrapedImageryLayer, DrapedImageryLayer } from '../types';
import { drapeStats } from './drape-stats';
import { emptyTile } from './raster-imagery-provider';

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

/** The whole globe at level 0, every tile empty: the base guard's provider. */
class BaseGuardProvider implements ImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle = Rectangle.MAX_VALUE;
  readonly tileWidth = RASTER_TILE_SIZE;
  readonly tileHeight = RASTER_TILE_SIZE;
  readonly minimumLevel = 0;
  readonly maximumLevel = 0;
  readonly hasAlphaChannel = true;
  readonly errorEvent = new Event();
  // Cesium tests each of these with `defined()`, though its declarations type them as present.
  readonly tileDiscardPolicy = undefined as unknown as TileDiscardPolicy;
  readonly credit = undefined as unknown as Credit;
  readonly proxy = undefined as unknown as ResourceProxy;

  getTileCredits(_x: number, _y: number, _level: number): Credit[] {
    return undefined as unknown as Credit[];
  }

  pickFeatures(
    _x: number,
    _y: number,
    _level: number,
    _longitude: number,
    _latitude: number,
  ): Promise<ImageryLayerFeatureInfo[]> | undefined {
    return undefined;
  }

  requestImage(): Promise<HTMLCanvasElement> {
    return Promise.resolve(emptyTile());
  }
}

/** Each collection's base guard and the Atlas layers that hold it. */
const guards = new WeakMap<
  ImageryLayerCollection,
  { layer: ImageryLayer; holders: number }
>();
const guardLayers = new WeakSet<ImageryLayer>();

/** Whether `layer` is a collection's base guard (a non-Atlas layer, at alpha 0). */
export function isDrapedBaseGuard(layer: ImageryLayer): boolean {
  return guardLayers.has(layer);
}

/**
 * Holds the collection's base guard, adding it on top when absent: no Atlas layer is on the
 * collection then, and each one added after goes above it. The returned call lets go of it.
 */
function holdBaseGuard(layers: ImageryLayerCollection): () => void {
  let guard = guards.get(layers);
  if (!guard) {
    const layer = new ImageryLayer(new BaseGuardProvider(), { alpha: 0 });
    guardLayers.add(layer);
    layers.add(layer);
    guard = { holders: 0, layer };
    guards.set(layers, guard);
  }
  guard.holders += 1;
  const held = guard;
  return () => {
    held.holders -= 1;
    if (held.holders > 0) return;
    guards.delete(layers);
    layers.remove(held.layer, true);
  };
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
  const releaseGuard = holdBaseGuard(scene.imageryLayers);
  names.set(layer, name);
  scene.imageryLayers.add(layer, insertionIndex(scene.imageryLayers, name));
  const unwatch = drapeStats.watchLayer(layer);

  let shownAt = 0;
  let frames = 0;
  let ready = false;
  let destroyed = false;
  let removePreRender: (() => void) | null = null;

  const checkReady = () => {
    frames += 1;
    if (
      (frames >= READY_FRAMES && scene.globe.tilesLoaded) ||
      performance.now() - shownAt >= DRAPED_READY_CAP_MS
    ) {
      ready = true;
      stopChecking();
      return;
    }
    scene.requestRender();
  };
  const stopChecking = () => {
    removePreRender?.();
    removePreRender = null;
  };
  /** Readiness from now: the layer was added, or shown again with none of its tiles left. */
  const startChecking = () => {
    shownAt = performance.now();
    frames = 0;
    ready = false;
    removePreRender ??= scene.preRender.addEventListener(checkReady);
  };

  startChecking();
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
      if (s) startChecking();
      else {
        stopChecking();
        ready = false;
      }
      scene.requestRender();
    },
    isReady: () => ready,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopChecking();
      removeTileLoaded();
      unwatch();
      scene.imageryLayers.remove(layer, true);
      releaseGuard();
      scene.requestRender();
      provider.destroy();
    },
  };
};
