import { ImageryLayer, Rectangle } from 'cesium';
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
  isDrapedBaseGuard,
  PREWARM_ALPHA,
} from '../src/atlas/scene/draped/draped-imagery-layer';
import {
  createDrapedSurfaceGroup,
  DRAPED_SURFACE_ALPHA,
} from '../src/atlas/scene/draped/draped-surface-group';
import {
  AtlasRasterImageryProvider,
  emptyTile,
} from '../src/atlas/scene/draped/raster-imagery-provider';
import { drapedRuntime } from '../src/atlas/scene/draped/runtime';
import type {
  DrapedSurfaceGroupOptions,
  DrapeStatsRecorder,
  DrapeWave,
  RasterImageryProvider,
  RasterTileSource,
  RasterWorkerClient,
} from '../src/atlas/scene/types';
import type { RasterReady, RasterTileBody } from '../src/atlas/worker/protocol';
import {
  deferred,
  FAKE_BOUNDS,
  FAKE_RECTANGLE,
  fakeDrapedScene,
  fakeProvider,
  fakeSource,
  imagerySkeletons,
  message,
  stubCesiumBrowserImageTypes,
  type FakeRasterSource,
} from './helpers/imagery-fakes';
import { SURFACE_SPEC } from './helpers/raster-specs';
import { flushTasks } from './helpers/scene-fakes';

let scene: ReturnType<typeof fakeDrapedScene>;

/** The collection's layers, bottom to top. */
function order(s: typeof scene): ImageryLayer[] {
  return Array.from({ length: s.imageryLayers.length }, (_, i) =>
    s.imageryLayers.get(i),
  );
}

/** Each layer's Atlas name, bottom to top; 'guard' for the base guard, undefined for the basemap. */
function stack(
  s: typeof scene,
): (AtlasImageryLayerName | 'guard' | undefined)[] {
  return order(s).map((l) =>
    isDrapedBaseGuard(l) ? 'guard' : drapedLayerName(l),
  );
}

beforeEach(() => {
  scene = fakeDrapedScene();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(stack(scene)).toEqual([
      undefined,
      'guard',
      'atlas-surface',
      'atlas-surface',
      'atlas-outlines',
      'atlas-outlines',
    ]);
    expect(order(scene).slice(2)).toEqual([sa, sb, oa, ob]);
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
      'guard',
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
      'guard',
      'atlas-surface',
      'atlas-outlines',
      'atlas-borders',
      'atlas-footprints',
    ]);
  });

  it('keeps one shown whole-globe guard at alpha 0 under the Atlas layers, removed with the last', async () => {
    stubCesiumBrowserImageTypes();
    const [a, b] = (['atlas-surface', 'atlas-outlines'] as const).map((name) =>
      addDrapedImageryLayer({
        alpha: 1,
        name,
        provider: fakeProvider(FAKE_RECTANGLE),
        scene,
      }),
    );
    const guard = scene.imageryLayers.get(0);
    expect(stack(scene)).toEqual(['guard', 'atlas-surface', 'atlas-outlines']);
    expect([guard.show, guard.alpha]).toEqual([true, 0]);
    expect(guard.imageryProvider.rectangle).toEqual(Rectangle.MAX_VALUE);
    expect(guard.imageryProvider.maximumLevel).toBe(0);
    expect(await guard.imageryProvider.requestImage(1, 0, 0)).toBe(emptyTile());
    expect(drapedLayerName(guard)).toBeUndefined();
    a.destroy();
    expect(stack(scene)).toEqual(['guard', 'atlas-outlines']);
    b.destroy();
    expect(scene.imageryLayers.length).toBe(0);
    expect(guard.isDestroyed()).toBe(true);
    addDrapedImageryLayer({
      alpha: 1,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    expect(stack(scene)).toEqual(['guard', 'atlas-surface']);
  });

  it('never makes an Atlas layer the base layer, whose edge Cesium would stretch over the globe', () => {
    // A cold draped load before the basemap arrives, then a hidden basemap (Context off), then shown.
    const atlas = (['atlas-surface', 'atlas-outlines'] as const).map(
      (name) =>
        addDrapedImageryLayer({
          alpha: 1,
          name,
          provider: fakeProvider(FAKE_RECTANGLE),
          scene,
        }).layer,
    );
    const outside = () =>
      atlas.map((l) => imagerySkeletons(scene.imageryLayers, l));
    expect(outside()).toEqual([[], []]);
    expect(atlas.map((l) => l.isBaseLayer())).toEqual([false, false]);
    const basemap = new ImageryLayer(fakeProvider(), { show: false });
    scene.imageryLayers.add(basemap, 0);
    expect(outside()).toEqual([[], []]);
    expect(atlas.map((l) => l.isBaseLayer())).toEqual([false, false]);
    basemap.show = true;
    expect(outside()).toEqual([[], []]);
    expect(atlas.map((l) => l.isBaseLayer())).toEqual([false, false]);
    expect(basemap.isBaseLayer()).toBe(true);
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
    scene.requestRender.mockClear();
    scene.globe.tilesLoaded = false;
    scene.preRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalledTimes(1);
    scene.preRender.raiseEvent();
    expect(scene.requestRender).toHaveBeenCalledTimes(2);
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

  // Cesium frees every tile of a hidden layer (pinned in tests/atlas-cesium-internals.test.ts), so a
  // layer shown again has none until the globe loads them anew.
  it('is not ready after a hide until tilesLoaded holds again from the second frame, or the cap', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const layer = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    scene.globe.tilesLoaded = true;
    scene.preRender.raiseEvent();
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(true);

    now.mockReturnValue(10_000);
    layer.setShown(false);
    expect(layer.isReady()).toBe(false);
    // A hidden layer loads no tiles, so it asks for no frame and stays unready.
    scene.requestRender.mockClear();
    scene.preRender.raiseEvent();
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(false);
    expect(scene.requestRender).not.toHaveBeenCalled();

    now.mockReturnValue(20_000);
    layer.setShown(true);
    expect(layer.isReady()).toBe(false);
    // The first frame after the show still reads the load queues of the frame before it.
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(false);
    expect(scene.requestRender).toHaveBeenCalled();
    scene.globe.tilesLoaded = false;
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(false);
    scene.globe.tilesLoaded = true;
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(true);

    // The cap counts from the show, not from the add.
    layer.setShown(false);
    layer.setShown(true);
    scene.globe.tilesLoaded = false;
    now.mockReturnValue(22_999);
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(false);
    now.mockReturnValue(23_000);
    scene.preRender.raiseEvent();
    expect(layer.isReady()).toBe(true);
    scene.requestRender.mockClear();
    scene.preRender.raiseEvent();
    expect(scene.requestRender).not.toHaveBeenCalled();
  });

  it('leaves no readiness listener behind when destroyed while hidden or shown again', () => {
    const hidden = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    hidden.setShown(false);
    hidden.destroy();
    const reshown = addDrapedImageryLayer({
      alpha: 0,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene,
    });
    reshown.setShown(false);
    reshown.setShown(true);
    reshown.destroy();
    expect(scene.preRender.numberOfListeners).toBe(0);
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
    expect(scene.imageryLayers.length).toBe(before + 2); // with the base guard
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

  it.each([Number.NaN, Infinity, -1])(
    'rejects a tile whose raster time is %s ms, closes its bitmap and counts it as failed',
    async (rasterMs) => {
      const close = vi.fn();
      const pending = wrapped.tile(body(1, 0, 3));
      source.tiles.get('1/0/3')!.resolve({
        ...message(1, 0, 3, { close } as unknown as ImageBitmap),
        rasterMs,
      });
      await expect(pending).rejects.toThrow(RangeError);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stats.read()).toMatchObject({
        delivered: 0,
        queueDepth: 0,
        rasterMs: { counts: [0, 0, 0, 0, 0, 0, 0] },
        requested: 1,
      });
    },
  );

  it('fails loudly when a watched layer has no imagery cache', () => {
    stats.watchLayer({} as unknown as ImageryLayer);
    expect(() => stats.read()).toThrow(/_imageryCache/);
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

describe('DrapedSurfaceGroup', () => {
  const BITMAP = { height: 256, width: 256 } as unknown as ImageBitmap;
  const REST: DrapeWave = { progress: () => 1, running: () => false };
  const FIXED = { color: '#ff0000', mode: 'fixed' } as const;

  let source: FakeRasterSource;
  let signal: AbortSignal;
  let OPTIONS: Omit<DrapedSurfaceGroupOptions, 'scene' | 'source' | 'wave'>;

  /** The Atlas layers' names and alphas, bottom to top; the base guard and basemap left out. */
  function alphas(s: typeof scene): [AtlasImageryLayerName, number][] {
    return order(s).flatMap((l): [AtlasImageryLayerName, number][] => {
      const name = drapedLayerName(l);
      return name ? [[name, l.alpha]] : [];
    });
  }

  /** The layers named `name`, bottom to top. */
  function named(s: typeof scene, name: AtlasImageryLayerName): ImageryLayer[] {
    return order(s).filter((l) => drapedLayerName(l) === name);
  }

  function providerOf(layer: ImageryLayer): RasterImageryProvider {
    return layer.imageryProvider as RasterImageryProvider;
  }

  function frames(count: number): void {
    for (let i = 0; i < count; i += 1) scene.preRender.raiseEvent();
  }

  /** One rendered frame: preRender, the draw, then postRender. */
  function drawFrame(): void {
    scene.preRender.raiseEvent();
    scene.postRender.raiseEvent();
  }

  beforeEach(() => {
    source = fakeSource();
    signal = new AbortController().signal;
    OPTIONS = {
      artifactKey: SURFACE_SPEC.artifactKey,
      cellEdges: false,
      edgeColor: { mode: 'matched' },
      onError: vi.fn(),
      surface: SURFACE_SPEC,
      surfaceOpacity: 0.58,
    };
  });

  it('drapes atlas-surface at 0.9 × surface opacity × opacity × progress', async () => {
    expect(DRAPED_SURFACE_ALPHA).toBe(0.9);
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source,
      wave: REST,
    });
    expect(group.kind).toBe('draped');
    expect(group.artifactKey).toBe(SURFACE_SPEC.artifactKey);
    expect(group.cells).toEqual({ masked: true, supported: true });
    await group.prepare(signal);
    expect(source.prepare).toHaveBeenCalledWith(
      SURFACE_SPEC,
      expect.any(AbortSignal),
    );
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58, 9)],
    ]);
    group.setOpacity(0.5);
    expect(group.opacity()).toBe(0.5);
    expect(alphas(scene)[0][1]).toBeCloseTo(0.9 * 0.58 * 0.5, 9);
    group.setSurfaceOpacity(1);
    expect(alphas(scene)[0][1]).toBeCloseTo(0.45, 9);
  });

  it('fades both layers with the wave on each frame while it runs', async () => {
    let progress = 0;
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: { progress: () => progress, running: () => true },
    });
    await group.prepare(signal);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', 0],
      ['atlas-outlines', 0],
    ]);
    progress = 0.5;
    scene.preRender.raiseEvent();
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58 * 0.5, 9)],
      ['atlas-outlines', 0.5],
    ]);
    progress = 1;
    scene.preRender.raiseEvent();
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58, 9)],
      ['atlas-outlines', 1],
    ]);
  });

  it('adds atlas-outlines only once cell edges are on, then toggles them by alpha alone', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    expect(alphas(scene).map(([n]) => n)).toEqual(['atlas-surface']);
    expect(group.outlinesReady()).toBe(false);
    await group.setCellEdges(true);
    expect(source.prepare).toHaveBeenLastCalledWith(
      {
        artifactKey: SURFACE_SPEC.artifactKey,
        edgeColor: { mode: 'matched' },
        geometry: SURFACE_SPEC.geometry,
        gridSha256: SURFACE_SPEC.gridSha256,
        layer: 'outlines',
        metric: SURFACE_SPEC.metric,
        palette: SURFACE_SPEC.palette,
      },
      expect.any(AbortSignal),
    );
    expect(alphas(scene)[1]).toEqual(['atlas-outlines', 1]);
    await group.setCellEdges(false);
    expect(alphas(scene)[1]).toEqual(['atlas-outlines', 0]);
    await group.setCellEdges(true);
    expect(source.prepare).toHaveBeenCalledTimes(2);
    expect(alphas(scene)[1]).toEqual(['atlas-outlines', 1]);
    expect(group.outlinesReady()).toBe(false);
    scene.globe.tilesLoaded = true;
    frames(2);
    expect(group.outlinesReady()).toBe(true);
  });

  it('keeps outlines independent of surface opacity and hides them with the surface layer', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    group.setSurfaceOpacity(0.2);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.18, 9)],
      ['atlas-outlines', 1],
    ]);
    group.setVisibility(false, false);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', 0],
      ['atlas-outlines', 0],
    ]);

    scene = fakeDrapedScene();
    const masksOnly = fakeSource();
    const unsupported = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source: masksOnly,
      surface: { ...SURFACE_SPEC, cells: { masked: true, supported: false } },
      wave: REST,
    });
    await unsupported.prepare(signal);
    await unsupported.setCellEdges(true);
    expect(alphas(scene).map(([n]) => n)).toEqual(['atlas-surface']);
    expect(masksOnly.prepare).toHaveBeenCalledTimes(1);
    expect(unsupported.outlinesReady()).toBe(true); // nothing to outline
  });

  it('replaces its outlines on setOutlineStyle, the old ones drawn until the new are ready', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    const [old] = named(scene, 'atlas-outlines');
    await group.setOutlineStyle(FIXED);
    expect(source.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ edgeColor: FIXED, layer: 'outlines' }),
      expect.any(AbortSignal),
    );
    const [, incoming] = named(scene, 'atlas-outlines');
    expect(named(scene, 'atlas-outlines')).toEqual([old, incoming]);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58, 9)],
      ['atlas-outlines', 1],
      ['atlas-outlines', 0],
    ]);
    expect(group.outlinesReady()).toBe(false);
    expect(source.release).not.toHaveBeenCalled();
    scene.globe.tilesLoaded = true;
    frames(1);
    scene.requestRender.mockClear();
    frames(1); // the new layer turns ready and stops asking: the group asks for the swap frame
    expect(group.outlinesReady()).toBe(true);
    expect(named(scene, 'atlas-outlines')).toEqual([old, incoming]);
    expect(scene.requestRender).toHaveBeenCalled();
    frames(1);
    expect(named(scene, 'atlas-outlines')).toEqual([incoming]);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58, 9)],
      ['atlas-outlines', 1],
    ]);
    expect(source.release.mock.calls).toEqual([[8]]);
    expect(group.outlinesReady()).toBe(true);
    await group.setOutlineStyle({ ...FIXED });
    expect(source.prepare).toHaveBeenCalledTimes(3);
  });

  it('drops the outlines of a style it has moved past, prepared or not', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    const slow = deferred<RasterReady>();
    source.prepare.mockReturnValueOnce(slow.promise);
    const first = group.setOutlineStyle(FIXED);
    const firstSignal = source.prepare.mock.calls[2][1];
    await group.setOutlineStyle({ color: '#00ff00', mode: 'fixed' });
    expect(firstSignal.aborted).toBe(true);
    slow.resolve({ bounds: FAKE_BOUNDS, rasterId: 42 });
    await first;
    expect(source.release).toHaveBeenCalledWith(42);
    expect(named(scene, 'atlas-outlines')).toHaveLength(2);
    scene.globe.tilesLoaded = true;
    frames(3);
    expect(named(scene, 'atlas-outlines')).toHaveLength(1);
    expect(source.release.mock.calls).toEqual([[42], [8]]);
  });

  it('drops its outlines on a restyle with edges off, and prepares the new style when they return', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    await group.setCellEdges(false);
    await group.setOutlineStyle(FIXED);
    expect(named(scene, 'atlas-outlines')).toEqual([]);
    expect(source.release).toHaveBeenCalledWith(8);
    expect(source.prepare).toHaveBeenCalledTimes(2);
    await group.setCellEdges(true);
    expect(source.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ edgeColor: FIXED, layer: 'outlines' }),
      expect.any(AbortSignal),
    );
    expect(alphas(scene)[1]).toEqual(['atlas-outlines', 1]);
  });

  it('is ready once its layers have loaded and drawn their pre-warm frame, and counts one ready chunk after its first drawn tile', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    expect(group.isReady()).toBe(false);
    await group.prepare(signal);
    expect([group.isReady(), group.readyCount(), group.totalCount()]).toEqual([
      false,
      0,
      1,
    ]);
    scene.globe.tilesLoaded = true;
    frames(2);
    expect([group.isReady(), group.readyCount()]).toEqual([false, 0]); // loaded: pre-warm next
    drawFrame();
    await vi.waitFor(() =>
      expect([group.isReady(), group.readyCount()]).toEqual([true, 1]),
    );
    const [surface] = named(scene, 'atlas-surface');
    const [outlines] = named(scene, 'atlas-outlines');
    expect(group.readyChunkCount()).toBe(0);
    providerOf(surface).tileLoaded.raiseEvent(message(0, 0, 3, null));
    providerOf(outlines).tileLoaded.raiseEvent(message(0, 0, 3, BITMAP, 8));
    expect(group.readyChunkCount()).toBe(0);
    providerOf(surface).tileLoaded.raiseEvent(message(1, 0, 3, BITMAP));
    providerOf(surface).tileLoaded.raiseEvent(message(2, 0, 3, BITMAP));
    expect(group.readyChunkCount()).toBe(1);
  });

  // A hidden group's layers lose their tiles (Cesium frees them), so shown again it is neither
  // ready nor counts a drawn tile until the globe has its tiles again.
  it('is ready and counts a drawn tile again only once its tiles reload after a hide', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    scene.globe.tilesLoaded = true;
    frames(2);
    const [surface] = named(scene, 'atlas-surface');
    providerOf(surface).tileLoaded.raiseEvent(message(1, 0, 3, BITMAP));
    // Drawn at rest, its layers need no pre-warm frame: ready once that settles.
    await vi.waitFor(() =>
      expect([group.isReady(), group.readyChunkCount()]).toEqual([true, 1]),
    );
    expect(group.outlinesReady()).toBe(true);

    group.collection.show = false;
    expect(group.isReady()).toBe(false);
    expect(group.outlinesReady()).toBe(false);
    group.collection.show = true;
    expect([group.isReady(), group.readyChunkCount()]).toEqual([false, 0]);
    expect(group.outlinesReady()).toBe(false);
    frames(2);
    expect(group.isReady()).toBe(true); // warm already: no second pre-warm
    expect(group.outlinesReady()).toBe(true);
    expect(group.readyChunkCount()).toBe(0);
    providerOf(surface).tileLoaded.raiseEvent(message(1, 0, 3, BITMAP));
    expect(group.readyChunkCount()).toBe(1);
  });

  it('draws nothing with both cells off, keeping its raster', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    group.setVisibility(false, false);
    expect(alphas(scene)[0][1]).toBe(0);
    group.setVisibility(true, true);
    expect(alphas(scene)[0][1]).toBeCloseTo(0.522, 9);
    expect(source.release).not.toHaveBeenCalled();
  });

  it('maps collection.show to setShown and ignores elevation, scene mode and edge holds', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    group.collection.show = false;
    expect(group.collection.show).toBe(false);
    expect(named(scene, 'atlas-surface')[0].show).toBe(false);
    await group.setCellEdges(true); // a layer added while hidden comes in hidden
    expect(named(scene, 'atlas-outlines')[0].show).toBe(false);
    group.collection.show = true;
    expect(order(scene).map((l) => l.show)).toEqual([true, true, true]);
    const before = alphas(scene);
    group.setElevationFactor(3);
    await group.setSceneMode('map');
    group.setEdgesHeld(true);
    expect(alphas(scene)).toEqual(before);
  });

  it("reports its providers' errorEvent through onError", async () => {
    const onError = vi.fn();
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      onError,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    const surfaceError = new Error('surface tile');
    const outlineError = new Error('outline tile');
    providerOf(named(scene, 'atlas-surface')[0]).errorEvent.raiseEvent(
      surfaceError,
    );
    providerOf(named(scene, 'atlas-outlines')[0]).errorEvent.raiseEvent(
      outlineError,
    );
    expect(onError.mock.calls).toEqual([[surfaceError], [outlineError]]);
  });

  it('fails its prepare on a raster error while preparing, and reports a later one through onError', async () => {
    const failing = fakeSource();
    failing.prepare.mockImplementation(async (spec) => {
      if (spec.layer === 'outlines') throw new Error('outline raster');
      return { bounds: FAKE_BOUNDS, rasterId: 7 };
    });
    const onError = vi.fn();
    const preparing = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      onError,
      scene,
      source: failing,
      wave: REST,
    });
    await expect(preparing.prepare(signal)).rejects.toThrow('outline raster');
    expect(onError).not.toHaveBeenCalled();

    const prepared = createDrapedSurfaceGroup({
      ...OPTIONS,
      onError,
      scene,
      source: failing,
      wave: REST,
    });
    await prepared.prepare(signal);
    await expect(prepared.setCellEdges(true)).resolves.toBeUndefined();
    expect(onError.mock.calls).toEqual([[new Error('outline raster')]]);

    const surfaceFails = fakeSource();
    surfaceFails.prepare.mockRejectedValueOnce(new Error('surface raster'));
    await expect(
      createDrapedSurfaceGroup({
        ...OPTIONS,
        onError,
        scene,
        source: surfaceFails,
        wave: REST,
      }).prepare(signal),
    ).rejects.toThrow('surface raster');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('adds no layer for a raster with nothing to draw, and is ready at once', async () => {
    const empty = fakeSource(null);
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source: empty,
      wave: REST,
    });
    await group.prepare(signal);
    expect(scene.imageryLayers.length).toBe(0);
    expect(group.isReady()).toBe(true);
    expect(group.readyChunkCount()).toBe(0);
    expect(group.outlinesReady()).toBe(true);
    expect(empty.release.mock.calls).toEqual([[7], [8]]);
  });

  it('removes both layers and releases both rasters on destroy, and drops a prepare it aborted', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    expect(scene.imageryLayers.length).toBe(3); // with the base guard
    group.destroy();
    expect(scene.imageryLayers.length).toBe(0);
    expect(source.release.mock.calls.sort()).toEqual([[7], [8]]);
    expect(scene.preRender.numberOfListeners).toBe(0);
    expect(group.isReady()).toBe(false);
    group.destroy();
    expect(source.release).toHaveBeenCalledTimes(2);
    await group.setCellEdges(true);
    await group.setOutlineStyle(FIXED);
    expect(source.prepare).toHaveBeenCalledTimes(2);

    const late = fakeSource();
    const ready = deferred<RasterReady>();
    late.prepare.mockReturnValueOnce(ready.promise);
    const aborted = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source: late,
      wave: REST,
    });
    const preparing = aborted.prepare(signal);
    const requestSignal = late.prepare.mock.calls[0][1];
    expect(requestSignal.aborted).toBe(false);
    aborted.destroy();
    expect(requestSignal.aborted).toBe(true);
    ready.resolve({ bounds: FAKE_BOUNDS, rasterId: 11 });
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(late.release.mock.calls).toEqual([[11]]);
    expect(scene.imageryLayers.length).toBe(0);
    expect(scene.preRender.numberOfListeners).toBe(0);
  });

  it('drops a prepare whose own signal aborts, leaving the rest to destroy', async () => {
    const late = fakeSource();
    const ready = deferred<RasterReady>();
    late.prepare.mockReturnValueOnce(ready.promise);
    const controller = new AbortController();
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      scene,
      source: late,
      wave: REST,
    });
    const preparing = group.prepare(controller.signal);
    controller.abort();
    expect(late.prepare.mock.calls[0][1].aborted).toBe(true);
    ready.resolve({ bounds: FAKE_BOUNDS, rasterId: 12 });
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(late.release.mock.calls).toEqual([[12]]);
    expect(scene.imageryLayers.length).toBe(0);
    group.destroy();
    expect(scene.preRender.numberOfListeners).toBe(0);
  });

  it('takes every setter after destroy as a no-op', async () => {
    // ScientificLayers may still hide or fade a group it has already destroyed.
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    group.destroy();
    scene.requestRender.mockClear();
    group.setOpacity(0);
    group.collection.show = false;
    group.setVisibility(false, false);
    group.setSurfaceOpacity(0.2);
    await group.setCellEdges(true);
    expect(scene.imageryLayers.length).toBe(0);
    expect(scene.requestRender).not.toHaveBeenCalled();
    expect(source.prepare).toHaveBeenCalledTimes(2);
  });

  it('stops the outline prepare it started when its own signal aborts', async () => {
    const outlineReady = deferred<RasterReady>();
    const late = fakeSource();
    late.prepare.mockImplementation(async (spec) =>
      spec.layer === 'outlines'
        ? outlineReady.promise
        : { bounds: FAKE_BOUNDS, rasterId: 7 },
    );
    const controller = new AbortController();
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source: late,
      wave: REST,
    });
    let outcome = 'pending';
    group.prepare(controller.signal).catch((error: Error) => {
      outcome = error.name;
    });
    await flushTasks();
    expect(late.prepare).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(late.prepare.mock.calls[1][1].aborted).toBe(true);
    await flushTasks();
    // Rejected at once, not once the outline raster lands.
    expect(outcome).toBe('AbortError');
    outlineReady.resolve({ bounds: FAKE_BOUNDS, rasterId: 8 });
    await flushTasks();
    expect(late.release.mock.calls).toEqual([[8]]);
    expect(named(scene, 'atlas-outlines')).toEqual([]);
    group.destroy();
    expect(late.release.mock.calls).toEqual([[8], [7]]);
  });

  it('shows at once when the wave rests (reduced motion, hidden tab)', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    group.setOpacity(0); // ScientificLayers' cold path: hidden until ready
    await group.prepare(signal);
    expect(alphas(scene)).toEqual([
      ['atlas-surface', 0],
      ['atlas-outlines', 0],
    ]);
    group.setOpacity(1); // ready: no frame needed to show it
    expect(alphas(scene)).toEqual([
      ['atlas-surface', expect.closeTo(0.9 * 0.58, 9)],
      ['atlas-outlines', 1],
    ]);
  });

  it('requests no frame at rest once its layers are ready', async () => {
    const group = createDrapedSurfaceGroup({
      ...OPTIONS,
      cellEdges: true,
      scene,
      source,
      wave: REST,
    });
    await group.prepare(signal);
    scene.globe.tilesLoaded = true;
    frames(2);
    expect(group.isReady()).toBe(false); // loaded: its pre-warm frame comes next
    drawFrame();
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    scene.requestRender.mockClear();
    frames(2);
    drawFrame();
    expect(scene.requestRender).not.toHaveBeenCalled();
  });
});

describe('pre-warm (#483 phase 4)', () => {
  type FakeScene = ReturnType<typeof fakeDrapedScene>;
  const REST: DrapeWave = { progress: () => 1, running: () => false };

  /** The frame listeners on `s`, preRender and postRender together. */
  function listeners(s: FakeScene): number {
    return s.preRender.numberOfListeners + s.postRender.numberOfListeners;
  }

  /** One rendered frame: preRender, the draw, then postRender. */
  function drawFrame(s: FakeScene): void {
    s.preRender.raiseEvent();
    s.postRender.raiseEvent();
  }

  /** A loaded `atlas-surface` layer at `alpha` on a scene of its own, with no frame requested. */
  function drapedLayerAt(alpha: number) {
    const s = fakeDrapedScene();
    const layer = addDrapedImageryLayer({
      alpha,
      name: 'atlas-surface',
      provider: fakeProvider(),
      scene: s,
    });
    s.globe.tilesLoaded = true;
    drawFrame(s);
    drawFrame(s);
    expect(layer.isReady()).toBe(true);
    s.requestRender.mockClear();
    return { layer, scene: s };
  }

  /** A prepared group at opacity 0 with its tiles loaded, and its Atlas layers by name. */
  async function loadedGroup(o: Partial<DrapedSurfaceGroupOptions> = {}) {
    const s = fakeDrapedScene();
    const group = createDrapedSurfaceGroup({
      artifactKey: SURFACE_SPEC.artifactKey,
      cellEdges: false,
      edgeColor: { mode: 'matched' },
      onError: vi.fn(),
      scene: s,
      source: fakeSource(),
      surface: SURFACE_SPEC,
      surfaceOpacity: 0.58,
      wave: REST,
      ...o,
    });
    group.setOpacity(0); // ScientificLayers' wait: hidden until ready
    await group.prepare(new AbortController().signal);
    s.globe.tilesLoaded = true;
    drawFrame(s);
    drawFrame(s);
    const layers: Partial<Record<AtlasImageryLayerName, ImageryLayer>> = {};
    for (const layer of order(s)) {
      const name = drapedLayerName(layer);
      if (name) layers[name] = layer;
    }
    s.requestRender.mockClear();
    return { group, layers, scene: s };
  }

  it('draws a layer at α 0.001 for one frame, then restores its α', async () => {
    expect(PREWARM_ALPHA).toBe(0.001);
    const { scene, layer } = drapedLayerAt(0);
    const baseline = listeners(scene);
    const warmed = layer.prewarm();
    expect(layer.prewarm()).toBe(warmed);
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA);
    expect(scene.requestRender).toHaveBeenCalled();
    scene.postRender.raiseEvent(); // that frame began before the pre-warm, so it does not count
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA);
    scene.preRender.raiseEvent();
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA); // drawn in this frame
    scene.requestRender.mockClear();
    scene.postRender.raiseEvent();
    await warmed;
    expect(layer.layer.alpha).toBe(0);
    expect(scene.requestRender).toHaveBeenCalled(); // a frame without the floor
    expect(listeners(scene)).toBe(baseline);
    expect(layer.prewarm()).toBe(warmed);
    scene.requestRender.mockClear();
    drawFrame(scene);
    expect(scene.requestRender).not.toHaveBeenCalled();
  });

  it('keeps an α set during the pre-warm frame', async () => {
    const { scene, layer } = drapedLayerAt(0);
    const warmed = layer.prewarm();
    layer.setAlpha(0); // the group writes its alpha on every frame
    expect(layer.layer.alpha).toBe(PREWARM_ALPHA);
    scene.preRender.raiseEvent();
    layer.setAlpha(0.3);
    expect(layer.layer.alpha).toBe(0.3);
    scene.postRender.raiseEvent();
    await warmed;
    expect(layer.layer.alpha).toBe(0.3);

    const faint = drapedLayerAt(0);
    const faintWarmed = faint.layer.prewarm();
    faint.scene.preRender.raiseEvent();
    faint.layer.setAlpha(0.0004);
    expect(faint.layer.layer.alpha).toBe(PREWARM_ALPHA);
    faint.scene.postRender.raiseEvent();
    await faintWarmed;
    expect(faint.layer.layer.alpha).toBe(0.0004);
  });

  it('leaves a drawn or hidden layer alone', async () => {
    for (const alpha of [0.5, PREWARM_ALPHA]) {
      const drawn = drapedLayerAt(alpha);
      const baseline = listeners(drawn.scene);
      await drawn.layer.prewarm();
      expect(drawn.layer.layer.alpha).toBe(alpha);
      expect(listeners(drawn.scene)).toBe(baseline);
      expect(drawn.scene.requestRender).not.toHaveBeenCalled();
    }
    const hidden = drapedLayerAt(0);
    hidden.layer.setShown(false);
    hidden.scene.requestRender.mockClear();
    const baseline = listeners(hidden.scene);
    await hidden.layer.prewarm();
    expect(hidden.layer.layer.alpha).toBe(0);
    expect(listeners(hidden.scene)).toBe(baseline);
    expect(hidden.scene.requestRender).not.toHaveBeenCalled();
  });

  it('settles and lets go of the scene when destroyed mid pre-warm', async () => {
    const { scene, layer } = drapedLayerAt(0);
    const baseline = listeners(scene);
    const warmed = layer.prewarm();
    layer.destroy();
    await expect(warmed).resolves.toBeUndefined();
    expect(listeners(scene)).toBe(baseline);

    const during = drapedLayerAt(0);
    const duringWarmed = during.layer.prewarm();
    during.scene.preRender.raiseEvent(); // destroyed inside its pre-warm frame
    during.layer.destroy();
    await expect(duringWarmed).resolves.toBeUndefined();
    expect(listeners(during.scene)).toBe(0);
    during.scene.requestRender.mockClear();
    during.scene.postRender.raiseEvent();
    expect(during.scene.requestRender).not.toHaveBeenCalled();
    await expect(during.layer.prewarm()).resolves.toBeUndefined();
  });

  it('is ready only after its pre-warm frame has drawn', async () => {
    const { scene, group, layers } = await loadedGroup({ cellEdges: false });
    expect(group.isReady()).toBe(false);
    expect(layers['atlas-surface']!.alpha).toBe(PREWARM_ALPHA);
    scene.preRender.raiseEvent();
    expect(layers['atlas-surface']!.alpha).toBe(PREWARM_ALPHA); // the group's frame write keeps it
    expect(group.isReady()).toBe(false);
    scene.postRender.raiseEvent();
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    expect(group.readyCount()).toBe(1);
    expect(layers['atlas-surface']!.alpha).toBe(0);
    expect(listeners(scene)).toBe(1); // the group's own frame listener
  });

  it('pre-warms the outlines with the surface when edges are on', async () => {
    const { scene, group, layers } = await loadedGroup({ cellEdges: true });
    expect(group.isReady()).toBe(false);
    expect(layers['atlas-surface']!.alpha).toBe(PREWARM_ALPHA);
    expect(layers['atlas-outlines']!.alpha).toBe(PREWARM_ALPHA);
    drawFrame(scene);
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    expect(layers['atlas-surface']!.alpha).toBe(0);
    expect(layers['atlas-outlines']!.alpha).toBe(0);
  });

  it('waits for outlines that load after the surface, then pre-warms both in one frame', async () => {
    const s = fakeDrapedScene();
    const source = fakeSource();
    const outlines = deferred<RasterReady>();
    source.prepare.mockImplementation(async (spec) =>
      spec.layer === 'outlines'
        ? outlines.promise
        : { bounds: FAKE_BOUNDS, rasterId: 7 },
    );
    const group = createDrapedSurfaceGroup({
      artifactKey: SURFACE_SPEC.artifactKey,
      cellEdges: true,
      edgeColor: { mode: 'matched' },
      onError: vi.fn(),
      scene: s,
      source,
      surface: SURFACE_SPEC,
      surfaceOpacity: 0.58,
      wave: REST,
    });
    group.setOpacity(0);
    const preparing = group.prepare(new AbortController().signal);
    await vi.waitFor(() => expect(order(s).length).toBe(2)); // guard and surface
    const [surface] = order(s).filter(
      (l) => drapedLayerName(l) === 'atlas-surface',
    );
    s.globe.tilesLoaded = true;
    drawFrame(s);
    drawFrame(s);
    expect(group.isReady()).toBe(false); // the outlines the fade draws are still preparing
    expect(surface.alpha).toBe(0);
    outlines.resolve({ bounds: FAKE_BOUNDS, rasterId: 8 });
    await preparing;
    const [outline] = order(s).filter(
      (l) => drapedLayerName(l) === 'atlas-outlines',
    );
    expect(group.isReady()).toBe(false); // added, not yet loaded
    expect([surface.alpha, outline.alpha]).toEqual([0, 0]);
    drawFrame(s);
    drawFrame(s);
    expect(group.isReady()).toBe(false);
    expect([surface.alpha, outline.alpha]).toEqual([
      PREWARM_ALPHA,
      PREWARM_ALPHA,
    ]);
    drawFrame(s);
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
  });

  it('pre-warms only the layers its fade will draw', async () => {
    const edgesOnly = await loadedGroup({ cellEdges: true, surfaceOpacity: 0 });
    expect(edgesOnly.group.isReady()).toBe(false);
    expect(edgesOnly.layers['atlas-surface']!.alpha).toBe(0);
    expect(edgesOnly.layers['atlas-outlines']!.alpha).toBe(PREWARM_ALPHA);

    const unsupported = await loadedGroup({
      cellEdges: true,
      surface: { ...SURFACE_SPEC, cells: { masked: true, supported: false } },
    });
    expect(unsupported.layers['atlas-outlines']).toBeUndefined();
    expect(unsupported.group.isReady()).toBe(false);
    expect(unsupported.layers['atlas-surface']!.alpha).toBe(PREWARM_ALPHA);

    const hidden = await loadedGroup({ cellEdges: true });
    hidden.group.setVisibility(false, false); // both cell sets off: the fade draws nothing
    expect(hidden.group.isReady()).toBe(true);
    expect(hidden.layers['atlas-surface']!.alpha).toBe(0);
    expect(hidden.layers['atlas-outlines']!.alpha).toBe(0);
    expect(listeners(hidden.scene)).toBe(1);
  });

  it('asks for the frame that reads it ready when no pre-warm frame was drawn', async () => {
    const { scene, group, layers } = await loadedGroup({ cellEdges: true });
    group.setOpacity(1); // layers already drawn need no pre-warm frame
    expect(layers['atlas-surface']!.alpha).toBeGreaterThan(PREWARM_ALPHA);
    scene.requestRender.mockClear();
    expect(group.isReady()).toBe(false);
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    expect(scene.requestRender).toHaveBeenCalled();
  });

  // A hidden layer holds no tiles, so a group hidden as its layers load is not loaded: its one
  // pre-warm waits for it to be shown, rather than being used up with no frame drawn.
  it('keeps its pre-warm for when a group hidden as it loads is shown', async () => {
    const { scene, group, layers } = await loadedGroup({ cellEdges: true });
    group.collection.show = false;
    expect(group.isReady()).toBe(false);
    await Promise.resolve();
    expect(group.isReady()).toBe(false);
    expect(layers['atlas-surface']!.alpha).toBe(0);
    group.collection.show = true;
    drawFrame(scene);
    drawFrame(scene);
    expect(group.isReady()).toBe(false);
    expect(layers['atlas-surface']!.alpha).toBe(PREWARM_ALPHA);
    expect(layers['atlas-outlines']!.alpha).toBe(PREWARM_ALPHA);
    drawFrame(scene);
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    expect(layers['atlas-surface']!.alpha).toBe(0);
  });

  it('pre-warms once: a later edge toggle is instant', async () => {
    const { scene, group, layers } = await loadedGroup({ cellEdges: false });
    expect(group.isReady()).toBe(false);
    drawFrame(scene);
    await vi.waitFor(() => expect(group.isReady()).toBe(true));
    group.setOpacity(1);
    await group.setCellEdges(true);
    const [outline] = order(scene).filter(
      (l) => drapedLayerName(l) === 'atlas-outlines',
    );
    expect(group.isReady()).toBe(true);
    expect(outline.alpha).toBe(1);
    expect(layers['atlas-surface']!.alpha).toBeCloseTo(0.9 * 0.58, 9);
  });

  it('settles a group destroyed mid pre-warm and asks for no frame after', async () => {
    const { scene, group } = await loadedGroup({ cellEdges: true });
    expect(group.isReady()).toBe(false);
    scene.preRender.raiseEvent();
    group.destroy();
    expect(listeners(scene)).toBe(0);
    scene.requestRender.mockClear();
    scene.postRender.raiseEvent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(group.isReady()).toBe(false);
    expect(scene.requestRender).not.toHaveBeenCalled();
  });
});

describe('drapedRuntime', () => {
  it('carries the atlas-draped-v1 marker and counts tiles through its raster source', async () => {
    const client = {
      prepareRaster: vi.fn(async () => ({ bounds: null, rasterId: 3 })),
      rasterTile: vi.fn(async (b: RasterTileBody) => ({
        ...b,
        bitmap: null,
        rasterMs: 1,
      })),
      releaseRaster: vi.fn(async () => {}),
    } satisfies RasterWorkerClient;
    const before = drapedRuntime.stats.read().requested;
    const rasterSource = drapedRuntime.rasterSource(client);
    await rasterSource.tile({ level: 3, rasterId: 1, x: 0, y: 0 });
    expect(drapedRuntime.version).toBe('atlas-draped-v1');
    expect(drapedRuntime.stats.read().requested).toBe(before + 1);
    expect(client.rasterTile).toHaveBeenCalledWith({
      level: 3,
      rasterId: 1,
      x: 0,
      y: 0,
    });
    const signal = new AbortController().signal;
    expect(await rasterSource.prepare(SURFACE_SPEC, signal)).toEqual({
      bounds: null,
      rasterId: 3,
    });
    expect(client.prepareRaster).toHaveBeenCalledWith(SURFACE_SPEC, signal);
    rasterSource.release(3);
    expect(client.releaseRaster).toHaveBeenCalledWith(3);
  });

  it('warns when the worker cannot release a raster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('worker gone');
    const rasterSource = drapedRuntime.rasterSource({
      prepareRaster: vi.fn(),
      rasterTile: vi.fn(),
      releaseRaster: vi.fn(async () => {
        throw failure;
      }),
    });
    rasterSource.release(5);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/5/), failure),
    );
  });

  it('builds a provider for any raster, a border one stopping at its maximum level', async () => {
    const signal = new AbortController().signal;
    const provider = await drapedRuntime.providerFromSpec(
      fakeSource(),
      { color: '#ffffff', layer: 'borders', maximumLevel: 10 },
      signal,
    );
    expect(provider).toBeInstanceOf(AtlasRasterImageryProvider);
    expect(provider.maximumLevel).toBe(10);
  });

  it('hands out the draped group, the layer adder and the page’s drape stats', () => {
    expect(drapedRuntime.createDrapedSurfaceGroup).toBe(
      createDrapedSurfaceGroup,
    );
    expect(drapedRuntime.addDrapedImageryLayer).toBe(addDrapedImageryLayer);
    expect(drapedRuntime.stats).toBe(drapeStats);
  });
});
