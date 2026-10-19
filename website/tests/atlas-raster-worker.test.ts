/**
 * The data worker's raster runtime (terrain draping design, "Per layer under World Terrain" and
 * "How existing features behave": Worker, #483). The rasterisers are fakes, so these tests pin the
 * queue, the protocol and the bitmap options apart from the drawing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planChunks } from '../src/atlas/geometry/chunks';
import type { NaturalEarthBuffers } from '../src/atlas/geometry/natural-earth';
import { buildGridIndex } from '../src/atlas/geometry/raster/grid-index';
import type {
  FootprintRasterSpec,
  OutlineRasterSpec,
  RasterSpec,
  Rasterisers,
  SurfaceRasterInput,
  TileAddress,
  TileRaster,
} from '../src/atlas/geometry/raster/types';
import { SUPPORT_CODES } from '../src/atlas/gosa/decode';
import type { DecodedGrid, DecodedRender } from '../src/atlas/gosa/types';
import {
  COARSE_TILE_BUDGET,
  rasterKey,
} from '../src/atlas/worker/coarse-tiles';
import type {
  RasterResponse,
  WorkerErrorMessage,
} from '../src/atlas/worker/protocol';
import {
  ATLAS_RASTERISERS,
  createRasterRuntime,
  imageDataBitmap,
  type RasterWorkerContext,
} from '../src/atlas/worker/raster-handlers';
import { KENYA_CELLS, rasterInputFor } from './helpers/raster-fixtures';
import { BORDER_SPEC, SURFACE_SPEC } from './helpers/raster-specs';

/** Every texel 255. */
const FAKE_TILE: TileRaster = {
  rgba: new Uint8ClampedArray(256 * 256 * 4).fill(255),
};
/** The stand-in bitmap every drawn tile is made into. */
const BITMAP = { height: 256, width: 256 } as ImageBitmap;
/** The fake rasterisers' empty column. */
const EMPTY_X = 99;
/** `SURFACE_SPEC`'s artifact and style as an outline raster in a fixed colour. */
const OUTLINE_SPEC: OutlineRasterSpec = {
  artifactKey: SURFACE_SPEC.artifactKey,
  edgeColor: { color: '#ff8000', mode: 'fixed' },
  geometry: SURFACE_SPEC.geometry,
  gridSha256: SURFACE_SPEC.gridSha256,
  layer: 'outlines',
  metric: SURFACE_SPEC.metric,
  palette: SURFACE_SPEC.palette,
};
/** One 1 km footprint on `SURFACE_SPEC`'s artifact. */
const FOOTPRINT_SPEC: FootprintRasterSpec = {
  artifactKey: SURFACE_SPEC.artifactKey,
  circles: Float64Array.of(36.8, -1.3, 1),
  color: '#ffffff',
  layer: 'footprints',
};
/** One small closed border ring off the coast of West Africa. */
const tinyBorders: NaturalEarthBuffers = {
  labels: [],
  lonLat: Float64Array.of(0, 0, 1, 0, 1, 1, 0, 0),
  ringOffsets: Uint32Array.of(0, 4),
};

interface Posted {
  m: RasterResponse | WorkerErrorMessage;
  t: Transferable[];
}

function fakeRaster(_input: SurfaceRasterInput, a: TileAddress) {
  return a.x === EMPTY_X ? null : FAKE_TILE;
}

function fakeLines(_input: unknown, a: TileAddress) {
  return a.x === EMPTY_X ? null : FAKE_TILE;
}

/** The last message of `type` posted. */
function last<T extends Posted['m']['type']>(posted: Posted[], type: T) {
  const found = posted
    .map(({ m }) => m)
    .findLast((m): m is Extract<Posted['m'], { type: T }> => m.type === type);
  if (!found) throw new Error(`no ${type} was posted`);
  return found;
}

/**
 * A raster runtime over the Kenya disk, loaded as `SURFACE_SPEC`'s render tier and grid. `posted`
 * holds every message with its transfer list; `now` counts up by one per call; each yield records
 * `posted.length` into `yields` and runs `between()` when set (logged as 'load-detail' in `events`,
 * beside each posted tile); `holdYield()` makes the next yield wait for `releaseYield()`.
 */
export function rasterHarness(
  o: {
    rasterisers?: Rasterisers;
    naturalEarth?: () => NaturalEarthBuffers | null;
  } = {},
) {
  const input = rasterInputFor(KENYA_CELLS);
  const grid: DecodedGrid = {
    ...input.grid,
    gridSha256: SURFACE_SPEC.gridSha256,
  };
  const { topology } = input;
  const preparedGrid = { plan: planChunks(grid, topology), topology };
  const render: DecodedRender = {
    artifact: {
      metric_domains: { post_mean: [0, 1], post_sd: [0, 1] },
    } as unknown as DecodedRender['artifact'],
    post_mean: Float32Array.from(KENYA_CELLS, (cell) => cell.value),
    post_sd: Float32Array.from(KENYA_CELLS, () => 0.1),
    support: Uint8Array.from(KENYA_CELLS, (cell) =>
      SUPPORT_CODES.indexOf(cell.support),
    ),
  };
  /** Loaded grids by sha; the render tier was decoded against `grid`. */
  const grids = new Map([[grid.gridSha256, grid]]);
  const posted: Posted[] = [];
  const yields: number[] = [];
  const events: string[] = [];
  const cancelled = new Set<number>();
  const hooks: { between?: () => void } = {};
  let clock = 0;
  let gate: Promise<void> | null = null;
  let openGate = () => {};
  const rasterisers = o.rasterisers ?? {
    borders: vi.fn(fakeLines),
    footprints: vi.fn(fakeLines),
    outlines: vi.fn(fakeRaster),
    surface: vi.fn(fakeRaster),
  };
  const context = {
    gridFor: (key: string) =>
      key === SURFACE_SPEC.artifactKey
        ? grids.get(SURFACE_SPEC.gridSha256)
        : undefined,
    isCancelled: (id: number) => cancelled.has(id),
    naturalEarth: o.naturalEarth ?? (() => null),
    now: () => (clock += 1),
    post: (m: Posted['m'], t: Transferable[]) => {
      posted.push({ m, t });
      if (m.type === 'tile-ready') events.push(`tile ${m.id}`);
    },
    prepared: (sha: string) => (grids.has(sha) ? preparedGrid : undefined),
    render: (key: string) =>
      key === SURFACE_SPEC.artifactKey ? render : undefined,
    toBitmap: vi.fn(async (_raster: TileRaster) => BITMAP),
    yieldToEventLoop: () => {
      yields.push(posted.length);
      if (hooks.between) {
        events.push('load-detail');
        hooks.between();
      }
      const held = gate ?? Promise.resolve();
      gate = null;
      return held;
    },
  } satisfies RasterWorkerContext;
  return {
    set between(between: () => void) {
      hooks.between = between;
    },
    cancelled,
    context,
    events,
    grid,
    grids,
    holdYield: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    posted,
    rasterisers,
    releaseYield: () => openGate(),
    render,
    runtime: createRasterRuntime(context, rasterisers),
    topology,
    yields,
  };
}

type Harness = ReturnType<typeof rasterHarness>;

function prepare(h: Harness, id: number, spec: RasterSpec = SURFACE_SPEC) {
  return h.runtime.handlers['prepare-raster']({
    id,
    spec,
    type: 'prepare-raster',
  });
}

function tile(h: Harness, id: number, rasterId: number, x = 0) {
  return h.runtime.handlers['raster-tile']({
    id,
    level: 6,
    rasterId,
    type: 'raster-tile',
    x,
    y: 0,
  });
}

let h: Harness;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker raster runtime (terrain draping design, "How existing features behave": Worker)', () => {
  beforeEach(() => {
    h = rasterHarness();
  });

  it('answers prepare-raster with its own id as the raster id and the drawn bounds', async () => {
    await h.runtime.handlers['prepare-raster']({
      id: 7,
      spec: SURFACE_SPEC,
      type: 'prepare-raster',
    });
    expect(h.posted[0]).toEqual({
      m: {
        bounds: buildGridIndex(h.topology).bounds(() => true),
        id: 7,
        rasterId: 7,
        type: 'raster-ready',
      },
      t: [],
    });
  });

  it('bounds only the cells the raster draws: supported, masked, or the supported outlines', async () => {
    const unknown = SUPPORT_CODES.indexOf('unknown');
    for (let row = 10; row < h.render.support.length; row += 1)
      h.render.support[row] = unknown;
    const index = buildGridIndex(h.topology);
    const cases = [
      [{ masked: false, supported: true }, (row: number) => row < 10],
      [{ masked: true, supported: false }, (row: number) => row >= 10],
    ] as const;
    for (const [cells, drawn] of cases) {
      expect(index.bounds(drawn)).not.toEqual(index.bounds(() => true));
      h.posted.length = 0;
      await prepare(h, 3, { ...SURFACE_SPEC, cells });
      expect(h.posted[0].m).toMatchObject({ bounds: index.bounds(drawn) });
    }
    h.posted.length = 0;
    await prepare(h, 4, {
      ...SURFACE_SPEC,
      cells: { masked: false, supported: false },
    });
    expect(h.posted[0].m).toMatchObject({ bounds: null, type: 'raster-ready' });
    h.posted.length = 0;
    await h.runtime.handlers['prepare-raster']({
      id: 5,
      spec: OUTLINE_SPEC,
      type: 'prepare-raster',
    });
    expect(h.posted[0].m).toMatchObject({
      bounds: index.bounds((row) => row < 10),
      rasterId: 5,
    });
  });

  it('hands each rasteriser the render tier’s metric column, domain and style, and the tile', async () => {
    await prepare(h, 7, { ...SURFACE_SPEC, geometry: 'hexagons' });
    await tile(h, 11, 7, 5);
    expect(h.rasterisers.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        cells: SURFACE_SPEC.cells,
        contours: false,
        domain: [0, 1],
        geometry: 'hexagons',
        grid: h.grid,
        palette: 'rainbow',
        support: h.render.support,
        topology: h.topology,
        values: h.render.post_mean,
      }),
      { level: 6, x: 5, y: 0 },
    );
    await h.runtime.handlers['prepare-raster']({
      id: 8,
      spec: { ...OUTLINE_SPEC, metric: 'post_sd' },
      type: 'prepare-raster',
    });
    await tile(h, 12, 8, 6);
    expect(h.rasterisers.outlines).toHaveBeenCalledWith(
      expect.objectContaining({
        cells: { masked: false, supported: true },
        edgeColor: { color: '#ff8000', mode: 'fixed' },
        values: h.render.post_sd,
      }),
      { level: 6, x: 6, y: 0 },
    );
    const [surfaceInput] = vi.mocked(h.rasterisers.surface).mock.calls[0];
    const [outlineInput] = vi.mocked(h.rasterisers.outlines).mock.calls[0];
    expect(outlineInput.index).toBe(surfaceInput.index); // one index per topology
  });

  it('rasterises queued tiles first in, first out, yielding after each', async () => {
    await prepare(h, 7);
    await Promise.all([11, 12, 13].map((id) => tile(h, id, 7)));
    expect(h.posted.slice(1).map(({ m }) => m.id)).toEqual([11, 12, 13]);
    expect(h.yields).toEqual([2, 3, 4]);
  });

  it('lets a message that arrives between two tiles run before the second', async () => {
    const order: string[] = [];
    h.between = () => order.push('load-detail');
    await prepare(h, 7);
    await Promise.all([tile(h, 11, 7), tile(h, 12, 7)]);
    order.push(...h.posted.slice(1).map(({ m }) => `tile ${m.id}`));
    expect(order).toEqual(['load-detail', 'load-detail', 'tile 11', 'tile 12']);
    expect(h.events).toEqual([
      'tile 11',
      'load-detail',
      'tile 12',
      'load-detail',
    ]);
  });

  it('transfers a drawn tile’s bitmap with its raster time, and posts an empty tile as null', async () => {
    await prepare(h, 7);
    await tile(h, 11, 7, 5);
    await tile(h, 12, 7, EMPTY_X);
    const [drawn, empty] = h.posted.slice(1);
    expect(drawn).toEqual({
      m: {
        bitmap: BITMAP,
        id: 11,
        level: 6,
        rasterId: 7,
        rasterMs: 1,
        type: 'tile-ready',
        x: 5,
        y: 0,
      },
      t: [BITMAP],
    });
    expect(empty).toEqual({
      m: expect.objectContaining({ bitmap: null, id: 12, x: EMPTY_X }),
      t: [],
    });
    expect(h.context.toBitmap).toHaveBeenCalledTimes(1);
    expect(h.context.toBitmap).toHaveBeenCalledWith(FAKE_TILE);
  });

  it('fails a released raster’s queued tiles as cancelled and confirms the release', async () => {
    await prepare(h, 7);
    h.holdYield(); // the first tile's yield waits for release()
    const [first, second] = [tile(h, 11, 7), tile(h, 12, 7)];
    await h.runtime.handlers['release-raster']({
      id: 20,
      rasterId: 7,
      type: 'release-raster',
    });
    h.releaseYield();
    await Promise.all([first, second]);
    expect(
      h.posted.map(({ m }) => [m.id, m.type === 'error' ? m.code : m.type]),
    ).toEqual([
      [7, 'raster-ready'],
      [11, 'tile-ready'],
      [20, 'raster-released'],
      [12, 'cancelled'],
    ]);
  });

  it('fails a cancelled tile request as cancelled when it is reached', async () => {
    await prepare(h, 7);
    h.cancelled.add(11);
    await tile(h, 11, 7);
    expect(h.posted[1].m).toMatchObject({
      code: 'cancelled',
      id: 11,
      type: 'error',
    });
    expect(h.rasterisers.surface).not.toHaveBeenCalled();
  });

  it('reports a rasteriser failure as internal and keeps draining the queue', async () => {
    const failing = vi.fn((input: SurfaceRasterInput, a: TileAddress) => {
      if (a.x === 1) throw new Error('fan out of range');
      return fakeRaster(input, a);
    });
    h = rasterHarness({
      rasterisers: {
        ...h.rasterisers,
        outlines: failing,
        surface: failing,
      },
    });
    await prepare(h, 7);
    await Promise.all([tile(h, 11, 7, 1), tile(h, 12, 7, 2)]);
    expect(h.posted.slice(1).map(({ m }) => m)).toEqual([
      {
        code: 'internal',
        gosaCode: null,
        id: 11,
        message: 'fan out of range',
        type: 'error',
      },
      expect.objectContaining({ bitmap: BITMAP, id: 12, type: 'tile-ready' }),
    ]);
  });

  it('reports a missing render tier, an unloaded grid, a grid mismatch, an unprepared grid or borders before the context is parsed as internal, each by its own guard', async () => {
    const key = SURFACE_SPEC.artifactKey;
    // Each case leaves every other input loaded, so only its own guard can refuse it.
    const cases: [(h: Harness) => void, RasterSpec, string][] = [
      [
        () => {},
        { ...SURFACE_SPEC, artifactKey: 'absent' },
        'render tier absent is not loaded',
      ],
      [
        (h) => h.grids.clear(),
        SURFACE_SPEC,
        `the grid of render tier ${key} is not loaded`,
      ],
      [
        // Grid 'other' is loaded too, but the render tier was decoded against 'test-grid'.
        (h) => h.grids.set('other', { ...h.grid, gridSha256: 'other' }),
        { ...SURFACE_SPEC, gridSha256: 'other' },
        `render tier ${key} was decoded against grid test-grid, not other`,
      ],
      [
        (h) => {
          h.context.prepared = () => undefined;
        },
        SURFACE_SPEC,
        'grid test-grid is not loaded',
      ],
      [() => {}, BORDER_SPEC, 'Natural Earth context is not parsed'],
    ];
    for (const [setup, spec, message] of cases) {
      h = rasterHarness();
      setup(h);
      await h.runtime.handlers['prepare-raster']({
        id: 3,
        spec,
        type: 'prepare-raster',
      });
      expect(h.posted.map(({ m }) => m)).toEqual([
        { code: 'internal', gosaCode: null, id: 3, message, type: 'error' },
      ]);
    }
  });

  it('fails a prepare cancelled before it runs as cancelled, and keeps no raster for it', async () => {
    h.cancelled.add(7);
    await prepare(h, 7);
    h.cancelled.clear();
    await tile(h, 11, 7);
    expect(h.posted.map(({ m }) => m)).toEqual([
      {
        code: 'cancelled',
        gosaCode: null,
        id: 7,
        message: 'request superseded',
        type: 'error',
      },
      {
        code: 'cancelled',
        gosaCode: null,
        id: 11,
        message: 'raster 7 is released or was never prepared',
        type: 'error',
      },
    ]);
    expect(h.rasterisers.surface).not.toHaveBeenCalled();
  });

  it('hands the border rasteriser the parsed borders and the footprint rasteriser the circles, each in its colour', async () => {
    h = rasterHarness({ naturalEarth: () => tinyBorders });
    await h.runtime.handlers['prepare-raster']({
      id: 7,
      spec: { ...BORDER_SPEC, color: '#ff8000' },
      type: 'prepare-raster',
    });
    await tile(h, 11, 7, 5);
    expect(h.rasterisers.borders).toHaveBeenCalledWith(
      { borders: tinyBorders, color: '#ff8000' },
      { level: 6, x: 5, y: 0 },
    );
    await h.runtime.handlers['prepare-raster']({
      id: 8,
      spec: FOOTPRINT_SPEC,
      type: 'prepare-raster',
    });
    await tile(h, 12, 8, 6);
    expect(h.rasterisers.footprints).toHaveBeenCalledWith(
      { circles: FOOTPRINT_SPEC.circles, color: '#ffffff' },
      { level: 6, x: 6, y: 0 },
    );
    expect(h.posted.map(({ m }) => [m.id, m.type])).toEqual([
      [7, 'raster-ready'],
      [11, 'tile-ready'],
      [8, 'raster-ready'],
      [12, 'tile-ready'],
    ]);
  });

  it('tiles a footprint raster, an empty tile as null', async () => {
    const { posted, runtime } = rasterHarness({
      rasterisers: ATLAS_RASTERISERS,
    });
    const spec = {
      artifactKey: 'k',
      circles: Float64Array.of(-3.709, 40.419, 50),
      color: '#ff00ff',
      layer: 'footprints',
    } as const;
    await runtime.handlers['prepare-raster']({
      id: 5,
      spec,
      type: 'prepare-raster',
    });
    expect(last(posted, 'raster-ready')).toMatchObject({
      bounds: { north: expect.closeTo(40.419 + 50 / 111.195 + 1, 3) },
      rasterId: 5,
    });
    await runtime.handlers['raster-tile']({
      id: 6,
      level: 3,
      rasterId: 5,
      type: 'raster-tile',
      x: 7,
      y: 2,
    });
    expect(last(posted, 'tile-ready').bitmap).not.toBeNull();
    await runtime.handlers['raster-tile']({
      id: 7,
      level: 3,
      rasterId: 5,
      type: 'raster-tile',
      x: 0,
      y: 0,
    });
    expect(last(posted, 'tile-ready').bitmap).toBeNull();
  });

  it('refuses malformed footprints, and border tiles above their maximum level, as validation errors', async () => {
    const { posted, runtime } = rasterHarness({
      naturalEarth: () => tinyBorders,
      rasterisers: ATLAS_RASTERISERS,
    });
    await runtime.handlers['prepare-raster']({
      id: 8,
      spec: {
        artifactKey: 'k',
        circles: Float64Array.of(1, 2),
        color: '#ff00ff',
        layer: 'footprints',
      },
      type: 'prepare-raster',
    });
    expect(last(posted, 'error')).toMatchObject({
      code: 'validation',
      id: 8,
      message: expect.stringMatching(/lon, lat, radius_km triples/),
    });
    await runtime.handlers['prepare-raster']({
      id: 9,
      spec: { color: '#ffffff', layer: 'borders', maximumLevel: 10 },
      type: 'prepare-raster',
    });
    expect(last(posted, 'raster-ready')).toMatchObject({ rasterId: 9 });
    await runtime.handlers['raster-tile']({
      id: 10,
      level: 11,
      rasterId: 9,
      type: 'raster-tile',
      x: 0,
      y: 0,
    });
    expect(last(posted, 'error')).toMatchObject({
      code: 'validation',
      id: 10,
      message: expect.stringMatching(/maximum level 10/),
    });
    // At its maximum level the border tile is drawn: the ring's south-west corner is in it.
    await runtime.handlers['raster-tile']({
      id: 11,
      level: 10,
      rasterId: 9,
      type: 'raster-tile',
      x: 1024,
      y: 511,
    });
    expect(last(posted, 'tile-ready')).toMatchObject({ id: 11 });
    expect(last(posted, 'tile-ready').bitmap).not.toBeNull();
  });

  it('makes bitmaps unflipped and unpremultiplied, and carries the atlas-raster-v1 marker', async () => {
    const created = vi.fn(
      async (_image: ImageData, _options: ImageBitmapOptions) =>
        ({}) as ImageBitmap,
    );
    vi.stubGlobal('createImageBitmap', created);
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    await imageDataBitmap({ rgba });
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ height: 256, width: 256 }),
      {
        colorSpaceConversion: 'none',
        imageOrientation: 'from-image',
        premultiplyAlpha: 'none',
      },
    );
    expect(created.mock.calls[0][0].data).toBe(rgba); // the raster's own bytes, rows south-first
    expect(h.runtime.version).toBe('atlas-raster-v1');
  });
});

/** Asks for the tile of raster `rasterId` at `a`. */
function tileAt(h: Harness, id: number, rasterId: number, a: TileAddress) {
  return h.runtime.handlers['raster-tile']({
    id,
    rasterId,
    type: 'raster-tile',
    ...a,
  });
}

/** Every tile of `level`, row by row. */
function everyTile(level: number): TileAddress[] {
  const tiles: TileAddress[] = [];
  for (let y = 0; y < 2 ** level; y += 1)
    for (let x = 0; x < 2 ** (level + 1); x += 1) tiles.push({ level, x, y });
  return tiles;
}

describe('coarse tiles and the queue (terrain draping design, "Performance budget and measurement")', () => {
  beforeEach(() => {
    h = rasterHarness();
  });

  it('serves the finest queued tile first, and tiles of one level first in, first out', async () => {
    await prepare(h, 7);
    h.holdYield(); // the first tile's yield waits until every other tile is queued
    const tiles = [
      tileAt(h, 11, 7, { level: 4, x: 0, y: 0 }),
      tileAt(h, 12, 7, { level: 0, x: 0, y: 0 }),
      tileAt(h, 13, 7, { level: 7, x: 0, y: 0 }),
      tileAt(h, 14, 7, { level: 2, x: 0, y: 0 }),
      tileAt(h, 15, 7, { level: 7, x: 1, y: 0 }),
    ];
    h.releaseYield();
    await Promise.all(tiles);
    expect(h.posted.slice(1).map(({ m }) => m.id)).toEqual([
      11, 13, 15, 14, 12,
    ]);
  });

  it('serves a level 0–2 tile of a raster prepared again with the same spec without drawing it', async () => {
    await prepare(h, 7);
    await tileAt(h, 11, 7, { level: 0, x: 0, y: 0 });
    await tileAt(h, 12, 7, { level: 2, x: EMPTY_X, y: 0 });
    await prepare(h, 8);
    await tileAt(h, 13, 8, { level: 0, x: 0, y: 0 });
    await tileAt(h, 14, 8, { level: 2, x: EMPTY_X, y: 0 });
    expect(h.rasterisers.surface).toHaveBeenCalledTimes(2);
    expect(h.posted.slice(-3).map(({ m }) => m)).toEqual([
      expect.objectContaining({ type: 'raster-ready', rasterId: 8 }),
      expect.objectContaining({ bitmap: BITMAP, id: 13, rasterId: 8 }),
      expect.objectContaining({ bitmap: null, id: 14, rasterId: 8 }),
    ]);
    // a fresh bitmap of the kept bytes for every post
    expect(h.context.toBitmap).toHaveBeenCalledTimes(2);
    expect(h.context.toBitmap).toHaveBeenLastCalledWith(FAKE_TILE);
  });

  it('draws again a tile finer than level 2, a restyle, a tier loaded again and a tile that failed', async () => {
    let fail = true;
    const surface = vi.fn((input: SurfaceRasterInput, a: TileAddress) => {
      if (a.x === 1 && fail) {
        fail = false;
        throw new Error('fan out of range');
      }
      return fakeRaster(input, a);
    });
    h = rasterHarness({ rasterisers: { ...h.rasterisers, surface } });
    const coarse = { level: 0, x: 0, y: 0 };
    const draws = async (id: number, spec: RasterSpec, a: TileAddress) => {
      await prepare(h, id, spec);
      const before = surface.mock.calls.length;
      await tileAt(h, id + 100, id, a);
      return surface.mock.calls.length - before;
    };
    expect(await draws(1, SURFACE_SPEC, { level: 3, x: 0, y: 0 })).toBe(1);
    expect(await draws(2, SURFACE_SPEC, { level: 3, x: 0, y: 0 })).toBe(1);
    expect(await draws(3, SURFACE_SPEC, coarse)).toBe(1);
    expect(
      await draws(4, { ...SURFACE_SPEC, palette: 'viridis' }, coarse),
    ).toBe(1);
    expect(
      await draws(
        5,
        { ...SURFACE_SPEC, contours: true, geometry: 'honmoon' },
        coarse,
      ),
    ).toBe(1);
    expect(await draws(6, SURFACE_SPEC, coarse)).toBe(0);
    const reloaded = { ...h.render };
    h.context.render = () => reloaded;
    expect(await draws(7, SURFACE_SPEC, coarse)).toBe(1);
    expect(await draws(8, SURFACE_SPEC, { level: 0, x: 1, y: 0 })).toBe(1);
    expect(last(h.posted, 'error')).toMatchObject({
      id: 108,
      code: 'internal',
    });
    expect(await draws(9, SURFACE_SPEC, { level: 0, x: 1, y: 0 })).toBe(1);
    expect(last(h.posted, 'tile-ready')).toMatchObject({ id: 109 });
  });

  it('keeps a layer kind’s drawn coarse tiles up to every level 0–2 tile of one raster, dropping its raster used least recently first', async () => {
    const coarse = [0, 1, 2].flatMap(everyTile);
    expect(coarse).toHaveLength(42);
    expect(COARSE_TILE_BUDGET).toBe(coarse.length);
    let id = 100;
    const drawAll = async (rasterId: number) => {
      for (const a of coarse) await tileAt(h, (id += 1), rasterId, a);
    };
    await prepare(h, 1);
    await drawAll(1);
    await prepare(h, 2, { ...SURFACE_SPEC, palette: 'viridis' });
    await drawAll(2); // 84 drawn tiles: the first raster's 42 go
    const surface = vi.mocked(h.rasterisers.surface);
    expect(surface).toHaveBeenCalledTimes(84);
    await prepare(h, 3, { ...SURFACE_SPEC, palette: 'viridis' });
    await drawAll(3);
    expect(surface).toHaveBeenCalledTimes(84);
    await prepare(h, 4);
    await tileAt(h, (id += 1), 4, { level: 0, x: 0, y: 0 });
    expect(surface).toHaveBeenCalledTimes(85);
  });
});

describe('the coarse tiles’ raster key (terrain draping design, "Performance budget and measurement")', () => {
  /** One spec of each layer kind, every field set; `layer` picks the kind, so it is not varied. */
  const OUTLINE_MATCHED_SPEC: OutlineRasterSpec = {
    ...OUTLINE_SPEC,
    edgeColor: { mode: 'matched' },
  };
  const BASES: readonly RasterSpec[] = [
    SURFACE_SPEC,
    OUTLINE_SPEC,
    OUTLINE_MATCHED_SPEC,
    BORDER_SPEC,
    FOOTPRINT_SPEC,
  ];

  /** Each field of `spec` as a dotted path, a typed array as one field; `layer` aside. */
  function fieldsOf(spec: object, prefix = ''): string[] {
    return Object.entries(spec).flatMap(([name, value]) => {
      const path = `${prefix}${name}`;
      if (path === 'layer') return [];
      return value !== null &&
        typeof value === 'object' &&
        !ArrayBuffer.isView(value)
        ? fieldsOf(value as object, `${path}.`)
        : [path];
    });
  }

  /** `base` with one field changed, by the field's path. */
  function variantsOf(base: RasterSpec): [string, RasterSpec][] {
    const artifact = {
      artifactKey: { ...base, artifactKey: 'other-artifact' },
      geometry: { ...base, geometry: 'hexagons' },
      gridSha256: { ...base, gridSha256: 'other-grid' },
      metric: { ...base, metric: 'post_sd' },
      palette: { ...base, palette: 'viridis' },
    };
    switch (base.layer) {
      case 'surface':
        return Object.entries({
          ...artifact,
          'cells.masked': { ...base, cells: { ...base.cells, masked: false } },
          'cells.supported': {
            ...base,
            cells: { ...base.cells, supported: false },
          },
          contours: { ...base, contours: !base.contours },
        }) as [string, RasterSpec][];
      case 'outlines':
        return Object.entries({
          ...artifact,
          ...(base.edgeColor.mode === 'fixed'
            ? {
                'edgeColor.color': {
                  ...base,
                  edgeColor: { color: '#00ff00', mode: 'fixed' },
                },
                'edgeColor.mode': { ...base, edgeColor: { mode: 'matched' } },
              }
            : {
                'edgeColor.mode': {
                  ...base,
                  edgeColor: { color: '#00ff00', mode: 'fixed' },
                },
              }),
        }) as [string, RasterSpec][];
      case 'borders':
        return [
          ['color', { ...base, color: '#ff8000' }],
          ['maximumLevel', { ...base, maximumLevel: 10 }],
        ];
      case 'footprints':
        return [
          ['artifactKey', { ...base, artifactKey: 'other-artifact' }],
          // one radius of the triples changed, the rest the same
          [
            'circles',
            {
              ...base,
              circles: base.circles.map((v, k) => (k === 2 ? v + 1 : v)),
            },
          ],
          ['color', { ...base, color: '#000000' }],
        ];
    }
  }

  it('varies every field of every layer kind’s spec in these tests', () => {
    for (const base of BASES)
      expect(
        variantsOf(base)
          .map(([field]) => field)
          .sort(),
        `${base.layer} fields`,
      ).toEqual(fieldsOf(base).sort());
  });

  it('is a new key for a change of any one field, and the same key for an identical spec', () => {
    const sources = [{}, {}];
    for (const base of BASES) {
      const key = rasterKey(base, sources);
      expect(rasterKey(structuredClone(base), sources), base.layer).toBe(key);
      for (const [field, changed] of variantsOf(base))
        expect(rasterKey(changed, sources), `${base.layer} ${field}`).not.toBe(
          key,
        );
      expect(rasterKey(base, [sources[0], {}]), base.layer).not.toBe(key);
    }
  });

  it('refuses a spec field it cannot key by value, never leaving it out', () => {
    const withField = (odd: unknown) =>
      ({ ...BORDER_SPEC, odd }) as unknown as RasterSpec;
    for (const [odd, kind] of [
      [new Map([['a', 1]]), 'Map'],
      [new Date(0), 'Date'],
      [() => 0, 'function'],
      [Symbol('odd'), 'symbol'],
    ] as const)
      expect(() => rasterKey(withField({ deep: odd }), [])).toThrow(
        `raster spec field odd.deep is a ${kind}`,
      );
    // Null and undefined are values, each its own key.
    const keys = [null, undefined, 'null', 0].map((odd) =>
      rasterKey(withField(odd), []),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('draws a level 0–2 tile again for a change of any field the runtime can change alone, and never for an identical spec', async () => {
    for (const base of BASES) {
      h = rasterHarness({ naturalEarth: () => tinyBorders });
      // Any artifact key reads the same render tier and grid, so the spec alone changes.
      h.context.render = () => h.render;
      h.context.gridFor = () => h.grid;
      const drawer = vi.mocked(h.rasterisers[base.layer]);
      let id = 0;
      const draws = async (spec: RasterSpec) => {
        const before = drawer.mock.calls.length;
        await prepare(h, (id += 1), spec);
        await tileAt(h, (id += 1), id - 1, { level: 0, x: 0, y: 0 });
        expect(last(h.posted, 'tile-ready')).toMatchObject({ id });
        return drawer.mock.calls.length - before;
      };
      expect(await draws(base), base.layer).toBe(1);
      for (const [field, changed] of variantsOf(base)) {
        // The grid's sha comes with its grid, another source, so it cannot change alone here.
        if (field === 'gridSha256') continue;
        expect(await draws(changed), `${base.layer} ${field}`).toBe(1);
      }
      expect(await draws(structuredClone(base)), base.layer).toBe(0);
    }
  });

  it('draws again once the support layer is hidden: the surface without its masks', async () => {
    await prepare(h, 1);
    await tileAt(h, 2, 1, { level: 1, x: 2, y: 1 });
    await prepare(h, 3, {
      ...SURFACE_SPEC,
      cells: { ...SURFACE_SPEC.cells, masked: false },
    });
    await tileAt(h, 4, 3, { level: 1, x: 2, y: 1 });
    expect(h.rasterisers.surface).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.rasterisers.surface).mock.calls[1][0].cells).toEqual({
      masked: false,
      supported: true,
    });
  });

  it('keeps each layer kind’s coarse tiles apart, so restyles of one never drop another’s', async () => {
    h = rasterHarness({ naturalEarth: () => tinyBorders });
    const coarse = [0, 1, 2].flatMap(everyTile);
    let id = 100;
    const drawAll = async (rasterId: number, spec: RasterSpec) => {
      await prepare(h, rasterId, spec);
      for (const a of coarse) await tileAt(h, (id += 1), rasterId, a);
    };
    await drawAll(1, BORDER_SPEC);
    await drawAll(2, FOOTPRINT_SPEC);
    await drawAll(3, SURFACE_SPEC);
    await drawAll(4, { ...SURFACE_SPEC, palette: 'viridis' });
    await drawAll(5, { ...SURFACE_SPEC, geometry: 'hexagons' });
    expect(h.rasterisers.surface).toHaveBeenCalledTimes(3 * 42);
    // World Terrain off and on: the borders and footprints are prepared again, and served kept.
    await drawAll(6, BORDER_SPEC);
    await drawAll(7, FOOTPRINT_SPEC);
    expect(h.rasterisers.borders).toHaveBeenCalledTimes(42);
    expect(h.rasterisers.footprints).toHaveBeenCalledTimes(42);
  });
});
