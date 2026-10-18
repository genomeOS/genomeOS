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
import type {
  RasterResponse,
  WorkerErrorMessage,
} from '../src/atlas/worker/protocol';
import {
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
/** One 1 km footprint on `SURFACE_SPEC`'s artifact; no rasteriser draws it yet. */
const FOOTPRINT_SPEC: FootprintRasterSpec = {
  artifactKey: SURFACE_SPEC.artifactKey,
  circles: Float64Array.of(36.8, -1.3, 1),
  color: '#ffffff',
  layer: 'footprints',
};

interface Posted {
  m: RasterResponse | WorkerErrorMessage;
  t: Transferable[];
}

function fakeRaster(_input: SurfaceRasterInput, a: TileAddress) {
  return a.x === EMPTY_X ? null : FAKE_TILE;
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

function prepare(h: Harness, id: number, spec = SURFACE_SPEC) {
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
    h = rasterHarness({ rasterisers: { outlines: failing, surface: failing } });
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

  it('reports a missing render tier, an unloaded grid, a grid mismatch, an unprepared grid or a layer it cannot raster yet as internal, each by its own guard', async () => {
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
      [() => {}, BORDER_SPEC, 'the borders layer has no rasteriser yet'],
      [() => {}, FOOTPRINT_SPEC, 'the footprints layer has no rasteriser yet'],
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
