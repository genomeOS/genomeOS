import { GeographicTilingScheme, Rectangle } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RASTER_MAX_LEVEL,
  type RasterSpec,
} from '../src/atlas/geometry/raster/types';
import {
  AtlasRasterImageryProvider,
  emptyTile,
  RASTER_MAX_IN_FLIGHT,
} from '../src/atlas/scene/draped/raster-imagery-provider';
import {
  fakeSource,
  message,
  stubCesiumBrowserImageTypes,
  type FakeRasterSource,
} from './helpers/imagery-fakes';
import { SURFACE_SPEC } from './helpers/raster-specs';
import { flushTasks } from './helpers/scene-fakes';

const BITMAP = { height: 256, width: 256 } as unknown as ImageBitmap;

describe('AtlasRasterImageryProvider (#483)', () => {
  let signal: AbortSignal;
  let source: FakeRasterSource;
  let tiles: FakeRasterSource['tiles'];
  let p: AtlasRasterImageryProvider;

  beforeEach(async () => {
    stubCesiumBrowserImageTypes();
    signal = new AbortController().signal;
    source = fakeSource();
    tiles = source.tiles;
    p = await AtlasRasterImageryProvider.fromSpec(source, SURFACE_SPEC, signal);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a geographic provider over the prepared bounds, to level 11, with an alpha channel', async () => {
    const p = await AtlasRasterImageryProvider.fromSpec(
      fakeSource({ east: 40, north: 5, south: -5, west: 30 }),
      SURFACE_SPEC,
      signal,
    );
    expect(p.tilingScheme).toBeInstanceOf(GeographicTilingScheme);
    expect([
      p.tileWidth,
      p.tileHeight,
      p.maximumLevel,
      p.hasAlphaChannel,
    ]).toEqual([256, 256, 11, true]);
    expect(
      Rectangle.equalsEpsilon(
        p.rectangle,
        Rectangle.fromDegrees(30, -5, 40, 5),
        1e-12,
      ),
    ).toBe(true);
    expect(p.bounds).toEqual({ east: 40, north: 5, south: -5, west: 30 });
  });

  it('covers the whole globe when the raster has nothing to draw', async () => {
    const p = await AtlasRasterImageryProvider.fromSpec(
      fakeSource(null),
      SURFACE_SPEC,
      signal,
    );
    expect(p.bounds).toBeNull();
    expect(Rectangle.equals(p.rectangle, Rectangle.MAX_VALUE)).toBe(true);
    expect(p.minimumLevel).toBe(0);
    expect([p.tileDiscardPolicy, p.credit, p.proxy]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(p.getTileCredits(0, 0, 0)).toBeUndefined();
    expect(p.pickFeatures(0, 0, 0, 0, 0)).toBeUndefined();
  });

  it('prepares its spec through the source with the signal it is given', () => {
    expect(source.prepare).toHaveBeenCalledWith(SURFACE_SPEC, signal);
  });

  it("stops a border provider at the spec's maximum level", async () => {
    const levelOf = async (spec: RasterSpec) =>
      (await AtlasRasterImageryProvider.fromSpec(fakeSource(), spec, signal))
        .maximumLevel;
    expect(
      await levelOf({ color: '#ffffff', layer: 'borders', maximumLevel: 11 }),
    ).toBe(11);
    expect(
      await levelOf({ color: '#ffffff', layer: 'borders', maximumLevel: 10 }),
    ).toBe(10);
    expect(
      await levelOf({
        artifactKey: 'k',
        circles: Float64Array.of(0, 0, 10),
        color: '#ff00ff',
        layer: 'footprints',
      }),
    ).toBe(RASTER_MAX_LEVEL);
  });

  it('asks the source for each tile of its raster', () => {
    void p.requestImage(1, 2, 3);
    expect(source.tile).toHaveBeenCalledWith({
      level: 3,
      rasterId: 7,
      x: 1,
      y: 2,
    });
  });

  it('hands Cesium a drawn tile’s bitmap and one shared transparent canvas for every empty tile', async () => {
    stubCesiumBrowserImageTypes();
    const p = await AtlasRasterImageryProvider.fromSpec(
      source,
      SURFACE_SPEC,
      signal,
    );
    const drawn = p.requestImage(1, 2, 3)!;
    tiles.get('1/2/3')!.resolve(message(1, 2, 3, BITMAP));
    expect(await drawn).toBe(BITMAP);
    const [a, b] = [p.requestImage(4, 2, 3)!, p.requestImage(5, 2, 3)!];
    tiles.get('4/2/3')!.resolve(message(4, 2, 3, null));
    tiles.get('5/2/3')!.resolve(message(5, 2, 3, null));
    expect(await a).toBe(await b);
    expect(await a).toBe(emptyTile());
    expect(emptyTile().width).toBe(1);
    expect(emptyTile().height).toBe(1);
  });

  it('returns undefined while 8 of its tiles are in flight, so Cesium asks again next frame', async () => {
    expect(RASTER_MAX_IN_FLIGHT).toBe(8);
    for (let x = 0; x < RASTER_MAX_IN_FLIGHT; x += 1)
      expect(p.requestImage(x, 0, 4)).toBeDefined();
    expect(p.requestImage(8, 0, 4)).toBeUndefined();
    tiles.get('0/0/4')!.resolve(message(0, 0, 4, null));
    await flushTasks();
    expect(p.requestImage(8, 0, 4)).toBeDefined();
  });

  it('frees an in-flight slot when a tile fails', async () => {
    for (let x = 0; x < RASTER_MAX_IN_FLIGHT; x += 1)
      void p.requestImage(x, 0, 4)?.catch(() => {});
    tiles
      .get('0/0/4')!
      .reject(Object.assign(new Error('boom'), { code: 'internal' }));
    await flushTasks();
    expect(p.requestImage(8, 0, 4)).toBeDefined();
  });

  it('raises tileLoaded for each delivered tile', async () => {
    const loaded = vi.fn();
    p.tileLoaded.addEventListener(loaded);
    const r = p.requestImage(1, 1, 3)!;
    tiles.get('1/1/3')!.resolve(message(1, 1, 3, null));
    await r;
    expect(loaded).toHaveBeenCalledWith(message(1, 1, 3, null));
  });

  it('resolves a cancelled tile as empty, and rejects any other failure so Cesium raises errorEvent', async () => {
    const cancelled = p.requestImage(1, 1, 3)!;
    tiles
      .get('1/1/3')!
      .reject(
        Object.assign(new Error('raster released'), { code: 'cancelled' }),
      );
    expect(await cancelled).toBe(emptyTile());
    const aborted = p.requestImage(3, 1, 3)!;
    tiles.get('3/1/3')!.reject(new DOMException('aborted', 'AbortError'));
    expect(await aborted).toBe(emptyTile());
    const failed = p.requestImage(2, 1, 3)!;
    tiles
      .get('2/1/3')!
      .reject(Object.assign(new Error('boom'), { code: 'internal' }));
    await expect(failed).rejects.toThrow('boom');
  });

  it('releases its raster once, drops later requests and raises nothing after destroy', async () => {
    const loaded = vi.fn();
    p.tileLoaded.addEventListener(loaded);
    const pending = p.requestImage(1, 1, 3)!;
    p.destroy();
    p.destroy();
    expect(source.release).toHaveBeenCalledTimes(1);
    expect(source.release).toHaveBeenCalledWith(7);
    expect(p.requestImage(2, 1, 3)).toBeUndefined();
    const late = { close: vi.fn() } as unknown as ImageBitmap;
    tiles.get('1/1/3')!.resolve(message(1, 1, 3, late));
    expect(await pending).toBe(emptyTile());
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(loaded).not.toHaveBeenCalled();
    expect(p.isDestroyed()).toBe(true);
  });

  it('resolves a tile that fails after destroy as empty', async () => {
    const pending = p.requestImage(1, 1, 3)!;
    p.destroy();
    tiles
      .get('1/1/3')!
      .reject(Object.assign(new Error('boom'), { code: 'internal' }));
    expect(await pending).toBe(emptyTile());
  });
});
