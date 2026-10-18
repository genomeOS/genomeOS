import { ImageryLayer } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AtlasImageryLayerName } from '../src/atlas/geometry/raster/types';
import {
  createDrapeStats,
  DRAPE_RASTER_BINS_MS,
  drapeStats,
} from '../src/atlas/scene/draped/drape-stats';
import {
  addDrapedImageryLayer,
  DRAPED_READY_CAP_MS,
  drapedLayerName,
} from '../src/atlas/scene/draped/draped-imagery-layer';
import type {
  DrapeStatsRecorder,
  RasterTileSource,
} from '../src/atlas/scene/types';
import type { RasterTileBody } from '../src/atlas/worker/protocol';
import {
  fakeDrapedScene,
  fakeProvider,
  fakeSource,
  message,
  type FakeRasterSource,
} from './helpers/imagery-fakes';

let scene: ReturnType<typeof fakeDrapedScene>;

/** The collection's layers, bottom to top. */
function order(s: typeof scene): ImageryLayer[] {
  return Array.from({ length: s.imageryLayers.length }, (_, i) =>
    s.imageryLayers.get(i),
  );
}

/** Each layer's Atlas name, bottom to top; undefined for the basemap. */
function stack(s: typeof scene): (AtlasImageryLayerName | undefined)[] {
  return order(s).map((l) => drapedLayerName(l));
}

beforeEach(() => {
  scene = fakeDrapedScene();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addDrapedImageryLayer', () => {
  it('stacks surface below outlines above the basemap, a newer layer of a name above the older', () => {
    scene.imageryLayers.addImageryProvider(fakeProvider()); // basemap
    const [sa, oa, sb, ob] = (
      [
        'atlas-surface',
        'atlas-outlines',
        'atlas-surface',
        'atlas-outlines',
      ] as const
    ).map(
      (name) =>
        addDrapedImageryLayer({
          alpha: 1,
          name,
          provider: fakeProvider(),
          scene,
        }).layer,
    );
    expect(stack(scene)).toEqual(
      [undefined, sa, sb, oa, ob].map((l) => l && drapedLayerName(l)),
    );
    expect(order(scene).slice(1)).toEqual([sa, sb, oa, ob]);
  });

  it('keeps that order when the basemap arrives later at index 0', () => {
    addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-outlines',
      provider: fakeProvider(),
      scene,
    });
    addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    scene.imageryLayers.add(new ImageryLayer(fakeProvider()), 0);
    expect(stack(scene)).toEqual([
      undefined,
      'atlas-surface',
      'atlas-outlines',
    ]);
  });

  it('orders all four layers bottom to top whatever order they arrive in', () => {
    for (const name of [
      'atlas-footprints',
      'atlas-outlines',
      'atlas-borders',
      'atlas-surface',
    ] as const)
      addDrapedImageryLayer({
        alpha: 1,
        name,
        provider: fakeProvider(),
        scene,
      });
    expect(stack(scene)).toEqual([
      'atlas-surface',
      'atlas-outlines',
      'atlas-borders',
      'atlas-footprints',
    ]);
  });

  it('names only its own layers', () => {
    const basemap = scene.imageryLayers.addImageryProvider(fakeProvider());
    expect(drapedLayerName(basemap)).toBeUndefined();
  });

  it('is ready once tilesLoaded holds from the second frame after the add, or after 3 s', () => {
    expect(DRAPED_READY_CAP_MS).toBe(3_000);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const layer = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    scene.globe.tilesLoaded = true;
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(false);
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(true);
    scene.globe.tilesLoaded = false;
    const capped = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    now.mockReturnValue(2_999);
    scene.preRender.raiseEvent();
    expect(capped.isReady()).toBe(false);
    now.mockReturnValue(3_000);
    scene.preRender.raiseEvent();
    expect(capped.isReady()).toBe(true);
    expect(layer.isReady()).toBe(true);
  });

  it('requests frames until ready, writes numeric alpha and show, and renders each delivered tile', () => {
    const provider = fakeProvider();
    const l = addDrapedImageryLayer({
      alpha: 0.4,
      name: 'atlas-surface',
      provider,
      scene,
    });
    expect(l.layer.alpha).toBe(0.4);
    expect(l.name).toBe('atlas-surface');
    scene.preRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalled();
    l.setAlpha(0.25);
    expect(l.layer.alpha).toBe(0.25);
    l.setShown(false);
    expect(l.layer.show).toBe(false);
    scene.requestRender.mockClear();
    provider.tileLoaded.raiseEvent(message(0, 0, 3, null));
    expect(scene.requestRender).toHaveBeenCalledTimes(1);
  });

  it('stops requesting frames once ready', () => {
    addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    scene.globe.tilesLoaded = true;
    scene.preRender.raiseEvent();
    scene.preRender.raiseEvent();
    scene.requestRender.mockClear();
    scene.preRender.raiseEvent();
    expect(scene.requestRender).not.toHaveBeenCalled();
  });

  it('destroy removes the layer and destroys its provider, once', () => {
    scene.imageryLayers.addImageryProvider(fakeProvider()); // basemap
    const before = scene.imageryLayers.length;
    const provider = fakeProvider();
    const l = addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-surface',
      provider,
      scene,
    });
    expect(scene.imageryLayers.length).toBe(before + 1);
    l.destroy();
    expect(scene.imageryLayers.length).toBe(before);
    expect(scene.imageryLayers.contains(l.layer)).toBe(false);
    expect(l.layer.isDestroyed()).toBe(true);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(provider.tileLoaded.numberOfListeners).toBe(0);
    expect(scene.preRender.numberOfListeners).toBe(0);
    l.destroy();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(scene.imageryLayers.length).toBe(before);
    scene.requestRender.mockClear();
    l.setAlpha(0.5);
    l.setShown(false);
    provider.tileLoaded.raiseEvent(message(0, 0, 3, null));
    expect(scene.requestRender).not.toHaveBeenCalled();
  });

  it('destroys its provider without touching a scene already torn down', () => {
    const provider = fakeProvider();
    const l = addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-surface',
      provider,
      scene,
    });
    scene.imageryLayers.destroy();
    scene.requestRender.mockClear();
    expect(() => l.destroy()).not.toThrow();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(scene.requestRender).not.toHaveBeenCalled();
  });

  it('watches its layer with the page’s drape stats until destroyed', () => {
    const watch = vi.spyOn(drapeStats, 'watchLayer');
    const l = addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    expect(watch).toHaveBeenCalledWith(l.layer);
    const cache = (l.layer as unknown as { _imageryCache: object })
      ._imageryCache as Record<string, object>;
    cache.tile = { texture: { width: 256 } };
    const resident = drapeStats.read().residentBytes;
    expect(resident).toBeGreaterThanOrEqual(349_525);
    l.destroy();
    expect(drapeStats.read().residentBytes).toBe(resident - 349_525);
  });
});

describe('drape stats', () => {
  let source: FakeRasterSource;
  let stats: DrapeStatsRecorder;
  let wrapped: RasterTileSource;

  const body = (x: number, y: number, level: number): RasterTileBody => ({
    level,
    rasterId: 7,
    x,
    y,
  });

  async function deliver(
    into: RasterTileSource,
    level: number,
    ms: number,
  ): Promise<void> {
    const pending = into.tile(body(0, 0, level));
    source.tiles
      .get(`0/0/${level}`)!
      .resolve({ ...message(0, 0, level, null), rasterMs: ms });
    await pending;
  }

  beforeEach(() => {
    source = fakeSource();
    stats = createDrapeStats();
    wrapped = stats.source(source);
  });

  it('counts requested, delivered and empty tiles and the queue depth through the source it wraps', async () => {
    const stats = createDrapeStats();
    const wrapped = stats.source(source);
    const first = wrapped.tile(body(1, 0, 3));
    void wrapped.tile(body(2, 0, 3));
    expect(stats.read()).toMatchObject({
      delivered: 0,
      empty: 0,
      queueDepth: 2,
      requested: 2,
    });
    source.tiles.get('1/0/3')!.resolve(message(1, 0, 3, null));
    await first;
    expect(stats.read()).toMatchObject({
      delivered: 1,
      empty: 1,
      queueDepth: 1,
      requested: 2,
    });
  });

  it('counts a drawn tile as delivered and not empty, and a failed one as neither', async () => {
    const drawn = wrapped.tile(body(1, 0, 3));
    const failed = wrapped.tile(body(2, 0, 3));
    source.tiles
      .get('1/0/3')!
      .resolve(message(1, 0, 3, {} as unknown as ImageBitmap));
    source.tiles.get('2/0/3')!.reject(new Error('boom'));
    await drawn;
    await expect(failed).rejects.toThrow('boom');
    expect(stats.read()).toMatchObject({
      delivered: 1,
      empty: 0,
      queueDepth: 0,
      requested: 2,
    });
  });

  it('passes prepare and release through to the source it wraps', async () => {
    const signal = new AbortController().signal;
    const spec = {
      color: '#ffffff',
      layer: 'borders',
      maximumLevel: 11,
    } as const;
    expect(await wrapped.prepare(spec, signal)).toEqual({
      bounds: expect.any(Object),
      rasterId: 7,
    });
    expect(source.prepare).toHaveBeenCalledWith(spec, signal);
    wrapped.release(7);
    expect(source.release).toHaveBeenCalledWith(7);
  });

  it('bins raster time of level-3-and-finer tiles by 0.5, 1, 2, 4, 8, 16 ms and above', async () => {
    for (const [level, ms] of [
      [2, 0.1],
      [3, 0.4],
      [3, 0.5],
      [4, 1.5],
      [11, 3],
      [5, 20],
    ] as const)
      await deliver(wrapped, level, ms);
    expect(stats.read().rasterMs).toEqual({
      counts: [2, 0, 1, 1, 0, 0, 1],
      upperMs: [0.5, 1, 2, 4, 8, 16, Infinity],
    });
    expect(DRAPE_RASTER_BINS_MS).toEqual([0.5, 1, 2, 4, 8, 16, Infinity]);
  });

  it('reads a snapshot that later tiles do not change', async () => {
    const before = stats.read();
    await deliver(wrapped, 3, 0.4);
    expect(before.rasterMs.counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(before.requested).toBe(0);
  });

  it('counts resident bytes as non-empty cached tiles × 349,525', () => {
    const layer = {
      _imageryCache: {
        a: { texture: { width: 256 } },
        b: { texture: { width: 1 } },
        c: { texture: undefined },
      },
    } as unknown as ImageryLayer;
    const unwatch = stats.watchLayer(layer);
    expect(stats.read().residentBytes).toBe(349_525);
    unwatch();
    expect(stats.read().residentBytes).toBe(0);
  });
});
