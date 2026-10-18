/**
 * `AtlasRasterImageryProvider`, the Cesium imagery provider over one worker raster (terrain
 * draping design, "Per layer under World Terrain", Provider and group, #483; Atlas design §11).
 *
 * A geographic tiling scheme clipped to the drawn bounds, 256 × 256 tiles, levels 0–11 (a border
 * raster stops at its spec's `maximumLevel`). Each tile is asked of the worker; a drawn tile comes
 * back as its transferred `ImageBitmap`, an empty one as one shared 1 × 1 transparent canvas. At
 * most `RASTER_MAX_IN_FLIGHT` tiles are in flight: above it `requestImage` returns undefined and
 * Cesium asks again next frame, so the worker queue holds no backlog from an old camera. A
 * cancelled tile resolves as empty, since a rejection raises `errorEvent`, which reverts the
 * terrain; any other failure rejects. Worker tiles bypass Cesium's RequestScheduler, which is what
 * requests a render after a tile, so `tileLoaded` fires for each delivered one. `destroy` releases
 * the raster once; later requests are dropped and nothing is raised after it.
 *
 * Lazy: only the draped modules (`scene/draped/*`) import this module.
 */

import {
  Event,
  GeographicTilingScheme,
  Rectangle,
  type Credit,
  type ImageryLayerFeatureInfo,
  type Proxy as ResourceProxy,
  type TileDiscardPolicy,
} from 'cesium';

import {
  RASTER_MAX_LEVEL,
  RASTER_TILE_SIZE,
  type DegreeRectangle,
  type RasterSpec,
} from '../../geometry/raster/types';
import type { RasterTileMessage } from '../../worker/protocol';
import type { RasterImageryProvider, RasterTileSource } from '../types';

/** Tiles one provider may have in flight in the worker. */
export const RASTER_MAX_IN_FLIGHT = 8;

let sharedEmptyTile: HTMLCanvasElement | null = null;

/** The one 1 × 1 transparent canvas every empty tile resolves to. */
export function emptyTile(): HTMLCanvasElement {
  if (!sharedEmptyTile) {
    sharedEmptyTile = document.createElement('canvas');
    sharedEmptyTile.width = 1;
    sharedEmptyTile.height = 1;
  }
  return sharedEmptyTile;
}

/** A dropped tile request: its raster was released, or its request aborted. */
function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'cancelled' || name === 'AbortError';
}

export class AtlasRasterImageryProvider implements RasterImageryProvider {
  /** Prepares `spec` in the worker and serves its tiles. */
  static async fromSpec(
    src: RasterTileSource,
    spec: RasterSpec,
    signal: AbortSignal,
  ): Promise<AtlasRasterImageryProvider> {
    const { bounds, rasterId } = await src.prepare(spec, signal);
    const maximumLevel =
      spec.layer === 'borders' ? spec.maximumLevel : RASTER_MAX_LEVEL;
    return new AtlasRasterImageryProvider(src, rasterId, bounds, maximumLevel);
  }

  /** The drawn data's extent; null when the raster has nothing to draw. */
  readonly bounds: DegreeRectangle | null;
  readonly tileLoaded = new Event<(message: RasterTileMessage) => void>();
  readonly errorEvent = new Event();
  readonly tilingScheme = new GeographicTilingScheme();
  readonly rectangle: Rectangle;
  readonly tileWidth = RASTER_TILE_SIZE;
  readonly tileHeight = RASTER_TILE_SIZE;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly hasAlphaChannel = true;
  // Cesium tests each of these with `defined()`: worker tiles have no discard policy, credit or
  // proxy, though Cesium's declarations type them as always present.
  readonly tileDiscardPolicy = undefined as unknown as TileDiscardPolicy;
  readonly credit = undefined as unknown as Credit;
  readonly proxy = undefined as unknown as ResourceProxy;

  readonly #src: RasterTileSource;
  readonly #rasterId: number;
  #inFlight = 0;
  #destroyed = false;

  private constructor(
    src: RasterTileSource,
    rasterId: number,
    bounds: DegreeRectangle | null,
    maximumLevel: number,
  ) {
    this.#src = src;
    this.#rasterId = rasterId;
    this.bounds = bounds;
    this.maximumLevel = maximumLevel;
    this.rectangle = bounds
      ? Rectangle.fromDegrees(
          bounds.west,
          bounds.south,
          bounds.east,
          bounds.north,
        )
      : Rectangle.MAX_VALUE;
  }

  /** No per-tile credits. */
  getTileCredits(_x: number, _y: number, _level: number): Credit[] {
    return undefined as unknown as Credit[];
  }

  /** Picks go through `globe.pick` and the grid, never the imagery. */
  pickFeatures(
    _x: number,
    _y: number,
    _level: number,
    _longitude: number,
    _latitude: number,
  ): Promise<ImageryLayerFeatureInfo[]> | undefined {
    return undefined;
  }

  requestImage(
    x: number,
    y: number,
    level: number,
  ): Promise<ImageBitmap | HTMLCanvasElement> | undefined {
    if (this.#destroyed || this.#inFlight >= RASTER_MAX_IN_FLIGHT)
      return undefined;
    this.#inFlight += 1;
    return this.#src
      .tile({ level, rasterId: this.#rasterId, x, y })
      .then(
        (message) => {
          if (this.#destroyed) {
            message.bitmap?.close();
            return emptyTile();
          }
          this.tileLoaded.raiseEvent(message);
          return message.bitmap ?? emptyTile();
        },
        (error: unknown) => {
          if (this.#destroyed || isCancellation(error)) return emptyTile();
          throw error;
        },
      )
      .finally(() => {
        this.#inFlight -= 1;
      });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#src.release(this.#rasterId);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }
}
