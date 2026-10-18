/**
 * Fakes for the draped imagery layers: a worker raster source, a Cesium-ready imagery provider and
 * a draped scene (terrain draping design, "Per layer under World Terrain", #483).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  Event,
  GeographicTilingScheme,
  ImageryLayerCollection,
  Rectangle,
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
 * A ready geographic provider that requests nothing. Its events are Cesium's own, so
 * `tileLoaded.raiseEvent(message)` and `errorEvent.raiseEvent(error)` pass their payloads on.
 */
export function fakeProvider(): RasterImageryProvider & {
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
    rectangle: Rectangle.MAX_VALUE,
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

/** A Cesium 1.145 engine source file, `p` relative to `@cesium/engine/Source`. */
export function cesiumSource(p: string): string {
  const engine = path.dirname(
    createRequire(import.meta.url).resolve('@cesium/engine/package.json'),
  );
  return readFileSync(path.join(engine, 'Source', p), 'utf8');
}
