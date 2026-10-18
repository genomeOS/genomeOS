/**
 * Fakes for the draped imagery layers: a worker raster source, a Cesium-ready imagery provider and
 * a draped scene (terrain draping design, "Per layer under World Terrain", #483).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  EllipsoidTerrainProvider,
  Event,
  GeographicTilingScheme,
  ImageryLayerCollection,
  Rectangle,
  type ImageryLayer,
} from 'cesium';
import { vi, type Mock } from 'vitest';

import type {
  DegreeRectangle,
  RasterSpec,
} from '../../src/atlas/geometry/raster/types';
import type {
  DrapedScene,
  RasterImageryProvider,
  RasterTileSource,
} from '../../src/atlas/scene/types';
import type {
  RasterReady,
  RasterTileBody,
  RasterTileMessage,
} from '../../src/atlas/worker/protocol';
import { FakeEvent } from './scene-fakes';

export { stubCesiumBrowserImageTypes } from './cesium-stubs';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** The drawn bounds `fakeSource()` prepares when none are given; pass null for nothing to draw. */
export const FAKE_BOUNDS: DegreeRectangle = {
  east: 40,
  north: 5,
  south: -5,
  west: 30,
};

export type FakeRasterSource = RasterTileSource & {
  prepare: Mock<(s: RasterSpec, signal: AbortSignal) => Promise<RasterReady>>;
  release: Mock<(id: number) => void>;
  tile: Mock<(b: RasterTileBody) => Promise<RasterTileMessage>>;
  /** One pending tile per "x/y/level", the latest request's. */
  tiles: Map<string, Deferred<RasterTileMessage>>;
};

/** A worker raster source: each prepare answers a new raster id (7, 8, …) and `bounds`. */
export function fakeSource(
  bounds: DegreeRectangle | null = FAKE_BOUNDS,
): FakeRasterSource {
  let next = 7;
  const tiles = new Map<string, Deferred<RasterTileMessage>>();
  return {
    prepare: vi.fn(async () => ({ bounds, rasterId: next++ })),
    release: vi.fn(),
    tile: vi.fn((b: RasterTileBody) => {
      const pending = deferred<RasterTileMessage>();
      tiles.set(`${b.x}/${b.y}/${b.level}`, pending);
      return pending.promise;
    }),
    tiles,
  };
}

/** A worker tile message; `rasterId` defaults to `fakeSource`'s first raster. */
export function message(
  x: number,
  y: number,
  level: number,
  bitmap: ImageBitmap | null,
  rasterId = 7,
): RasterTileMessage {
  return { bitmap, level, rasterId, rasterMs: 1, x, y };
}

/**
 * A ready geographic provider over `rectangle` that requests nothing. Its events are Cesium's own,
 * so `tileLoaded.raiseEvent(message)` and `errorEvent.raiseEvent(error)` pass their payloads on.
 */
export function fakeProvider(
  rectangle: Rectangle = Rectangle.MAX_VALUE,
): RasterImageryProvider & {
  destroy: Mock<() => void>;
} {
  let destroyed = false;
  const provider = {
    bounds: null,
    credit: undefined,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    errorEvent: new Event(),
    getTileCredits: () => undefined,
    hasAlphaChannel: true,
    isDestroyed: () => destroyed,
    maximumLevel: 11,
    minimumLevel: 0,
    pickFeatures: () => undefined,
    proxy: undefined,
    rectangle,
    requestImage: () => undefined,
    tileDiscardPolicy: undefined,
    tileHeight: 256,
    tileLoaded: new Event<(message: RasterTileMessage) => void>(),
    tileWidth: 256,
    tilingScheme: new GeographicTilingScheme(),
  };
  return provider as unknown as RasterImageryProvider & {
    destroy: Mock<() => void>;
  };
}

/** What a test drives on a fake draped scene. */
export interface FakeDrapedSceneHandles {
  globe: { tilesLoaded: boolean };
  imageryLayers: ImageryLayerCollection;
  preRender: FakeEvent;
  postRender: FakeEvent;
  requestRender: Mock<() => void>;
}

/** A real ImageryLayerCollection, FakeEvent frames and a settable `globe.tilesLoaded`. */
export function fakeDrapedScene(): DrapedScene & FakeDrapedSceneHandles {
  const scene: FakeDrapedSceneHandles = {
    globe: { tilesLoaded: false },
    imageryLayers: new ImageryLayerCollection(),
    postRender: new FakeEvent(),
    preRender: new FakeEvent(),
    requestRender: vi.fn(),
  };
  return scene as unknown as DrapedScene & FakeDrapedSceneHandles;
}

/** `FAKE_BOUNDS` as a Cesium rectangle, for a provider clipped to drawn bounds. */
export const FAKE_RECTANGLE = Rectangle.fromDegrees(
  FAKE_BOUNDS.west,
  FAKE_BOUNDS.south,
  FAKE_BOUNDS.east,
  FAKE_BOUNDS.north,
);

/** A geographic level-3 terrain tile wholly outside `FAKE_BOUNDS` (x 2, y 1: 135..112.5 W, 45..67.5 N). */
export const OUTSIDE_TILE = { level: 3, x: 2, y: 1 } as const;

/**
 * The imagery Cesium attaches for `layer` to a fresh terrain tile, as `[x, y, level]` per imagery
 * tile: `ImageryLayer._createTileImagerySkeletons` on an ellipsoid terrain, after the collection's
 * `_update()` has chosen the base layer. Empty when the layer creates no skeleton.
 */
export function imagerySkeletons(
  layers: ImageryLayerCollection,
  layer: ImageryLayer,
  { level, x, y }: { level: number; x: number; y: number } = OUTSIDE_TILE,
): [number, number, number][] {
  (layers as unknown as { _update(): void })._update();
  const tile = {
    data: {
      imagery: [] as {
        loadingImagery: { x: number; y: number; level: number };
      }[],
    },
    level,
    rectangle: new GeographicTilingScheme().tileXYToRectangle(x, y, level),
    x,
    y,
  };
  (
    layer as unknown as {
      _createTileImagerySkeletons(t: unknown, terrain: unknown): boolean;
    }
  )._createTileImagerySkeletons(tile, new EllipsoidTerrainProvider());
  return tile.data.imagery.map(({ loadingImagery: i }) => [i.x, i.y, i.level]);
}

/** A Cesium 1.145 engine source file, `p` relative to `@cesium/engine/Source`. */
export function cesiumSource(p: string): string {
  const engine = path.dirname(
    createRequire(import.meta.url).resolve('@cesium/engine/package.json'),
  );
  return readFileSync(path.join(engine, 'Source', p), 'utf8');
}
