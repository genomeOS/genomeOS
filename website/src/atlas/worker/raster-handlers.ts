/**
 * The data worker's raster runtime for the draped Atlas layers (terrain draping design, "Per layer
 * under World Terrain" and "How existing features behave": Worker, #483; Atlas design §11).
 *
 * `prepare-raster` checks that the artifact's render tier and grid are loaded and agree, builds
 * the rasteriser input once (the grid index is cached per topology), and answers with its own id
 * as the raster id and the bounds of the cells the raster draws: supported cells when
 * `cells.supported`, masked cells when `cells.masked`, and supported cells only for outlines. A
 * prepare cancelled before it runs fails as `cancelled` and stores nothing; one cancelled after it
 * stored its raster is freed by the `release-raster` the client sends after the cancel, since the
 * client drops the late answer.
 *
 * `raster-tile` joins one first-in, first-out queue, which yields to the event loop after each
 * tile, so a `load-detail` that arrives meanwhile runs before the next tile. A tile whose request
 * was cancelled, or whose raster was released, fails as `cancelled` when it is reached. The
 * rasteriser alone is timed (`rasterMs`); a drawn tile's ImageBitmap is transferred, an empty one
 * posted as null. `release-raster` frees a raster and confirms once a tile of it being drawn has
 * been posted, so no tile of a released raster follows its `raster-released`.
 *
 * Every failure is posted as an error, never an empty tile (design, "Failure modes"); a failed
 * tile does not stop the queue. Bitmaps keep the rows south-first, unpremultiplied and without
 * colour conversion, as Cesium blends imagery as straight alpha. The rasterisers are injected, so
 * the queue is tested apart from the drawing. This module loads only through `import()`; its
 * `'atlas-raster-v1'` marker stays out of the worker's first load. Nothing here is stochastic.
 */

import type { NaturalEarthBuffers } from '../geometry/natural-earth';
import { buildGridIndex } from '../geometry/raster/grid-index';
import {
  RASTER_TILE_SIZE,
  type GridIndex,
  type OutlineRasterSpec,
  type RasterSpec,
  type Rasterisers,
  type SurfaceRasterInput,
  type SurfaceRasterSpec,
  type TileAddress,
  type TileRaster,
} from '../geometry/raster/types';
import { isSupportedCode } from '../geometry/support-codes';
import type { GridTopology } from '../geometry/topology';
import type { DecodedGrid, DecodedRender } from '../gosa/types';
import type { PreparedGrid } from './geometry-handlers';
import type {
  RasterReady,
  RasterRequestType,
  RasterResponse,
  WorkerErrorMessage,
  WorkerRequestOf,
} from './protocol';

export interface RasterWorkerContext {
  post(
    message: RasterResponse | WorkerErrorMessage,
    transfer: Transferable[],
  ): void;
  /** The geometry worker's cached topology and plan (`GeometryWorker.prepared`). */
  prepared(gridSha256: string): PreparedGrid | undefined;
  /** The grid a render tier was decoded against. */
  gridFor(artifactKey: string): DecodedGrid | undefined;
  render(artifactKey: string): DecodedRender | undefined;
  /** The parsed Natural Earth borders; null before `parse-context`. */
  naturalEarth(): NaturalEarthBuffers | null;
  isCancelled(id: number): boolean;
  /** Milliseconds; only differences are read. */
  now(): number;
  /** After each tile, so a `load-detail` that arrived meanwhile goes first. */
  yieldToEventLoop(): Promise<void>;
  /** An unflipped bitmap of the raster (`imageDataBitmap` in the worker). */
  toBitmap(raster: TileRaster): Promise<ImageBitmap>;
}

export interface RasterRuntime {
  readonly version: 'atlas-raster-v1';
  handlers: {
    [K in RasterRequestType]: (request: WorkerRequestOf<K>) => Promise<void>;
  };
}

/** Outlines are drawn on supported cells only. */
const OUTLINE_CELLS: SurfaceRasterSpec['cells'] = {
  masked: false,
  supported: true,
};

/** Rows stay south-first (no flip), alpha straight, colours as written. */
const BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  imageOrientation: 'from-image',
  premultiplyAlpha: 'none',
};

/** A missing or mismatched input, reported as `internal`. */
class RasterInputError extends Error {}

/** A prepared raster: the bounds of what it draws and its tile drawer. */
interface PreparedRaster {
  bounds: RasterReady['bounds'];
  draw(a: TileAddress): TileRaster | null;
}

interface TileJob {
  request: WorkerRequestOf<'raster-tile'>;
  done(): void;
}

/** The tile between its rasteriser and its post. */
interface DrawingTile {
  rasterId: number;
  posted: Promise<void>;
}

export function createRasterRuntime(
  c: RasterWorkerContext,
  rasterisers: Rasterisers,
): RasterRuntime {
  const indexes = new WeakMap<GridTopology, GridIndex>();
  const rasters = new Map<number, PreparedRaster>();
  const queue: TileJob[] = [];
  let draining = false;
  let drawing: DrawingTile | null = null;

  function fail(
    id: number,
    code: WorkerErrorMessage['code'],
    message: string,
  ): void {
    c.post({ code, gosaCode: null, id, message, type: 'error' }, []);
  }

  function failWith(id: number, error: unknown): void {
    fail(
      id,
      'internal',
      error instanceof Error ? error.message : String(error),
    );
  }

  function indexFor(topology: GridTopology): GridIndex {
    let index = indexes.get(topology);
    if (!index) {
      index = buildGridIndex(topology);
      indexes.set(topology, index);
    }
    return index;
  }

  function artifactInput(
    spec: SurfaceRasterSpec | OutlineRasterSpec,
    cells: SurfaceRasterSpec['cells'],
    contours: boolean,
  ): SurfaceRasterInput {
    const { artifactKey, gridSha256 } = spec;
    const render = c.render(artifactKey);
    if (!render)
      throw new RasterInputError(`render tier ${artifactKey} is not loaded`);
    const grid = c.gridFor(artifactKey);
    if (!grid)
      throw new RasterInputError(
        `the grid of render tier ${artifactKey} is not loaded`,
      );
    if (grid.gridSha256 !== gridSha256)
      throw new RasterInputError(
        `render tier ${artifactKey} was decoded against grid ${grid.gridSha256}, not ${gridSha256}`,
      );
    const prepared = c.prepared(gridSha256);
    if (!prepared)
      throw new RasterInputError(`grid ${gridSha256} is not loaded`);
    return {
      cells,
      contours,
      domain: render.artifact.metric_domains[spec.metric],
      geometry: spec.geometry,
      grid,
      index: indexFor(prepared.topology),
      palette: spec.palette,
      support: render.support,
      topology: prepared.topology,
      values: render[spec.metric],
    };
  }

  function drawnBounds(input: SurfaceRasterInput): RasterReady['bounds'] {
    const { cells, support } = input;
    return input.index.bounds((row) =>
      isSupportedCode(support[row]) ? cells.supported : cells.masked,
    );
  }

  function prepareRaster(spec: RasterSpec): PreparedRaster {
    switch (spec.layer) {
      case 'surface': {
        const input = artifactInput(spec, spec.cells, spec.contours);
        return {
          bounds: drawnBounds(input),
          draw: (a) => rasterisers.surface(input, a),
        };
      }
      case 'outlines': {
        const input = {
          ...artifactInput(spec, OUTLINE_CELLS, false),
          edgeColor: spec.edgeColor,
        };
        return {
          bounds: drawnBounds(input),
          draw: (a) => rasterisers.outlines(input, a),
        };
      }
      case 'borders':
      case 'footprints':
        throw new RasterInputError(
          `the ${spec.layer} layer has no rasteriser yet`,
        );
    }
  }

  /** Posts the tile's terminal message; never rejects. */
  async function drawTile(
    request: WorkerRequestOf<'raster-tile'>,
  ): Promise<void> {
    const { id, level, rasterId, x, y } = request;
    const raster = rasters.get(rasterId);
    if (c.isCancelled(id) || !raster) {
      fail(
        id,
        'cancelled',
        raster
          ? 'request superseded'
          : `raster ${rasterId} is released or was never prepared`,
      );
      return;
    }
    try {
      const start = c.now();
      const tile = raster.draw({ level, x, y });
      const rasterMs = c.now() - start;
      const bitmap = tile ? await c.toBitmap(tile) : null;
      c.post(
        { bitmap, id, level, rasterId, rasterMs, type: 'tile-ready', x, y },
        bitmap ? [bitmap] : [],
      );
    } catch (error) {
      failWith(id, error);
    }
  }

  async function drain(): Promise<void> {
    draining = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const posted = drawTile(job.request);
        drawing = { posted, rasterId: job.request.rasterId };
        await posted;
        drawing = null;
        job.done();
        await c.yieldToEventLoop();
      }
    } finally {
      // The next tile request restarts the loop, should a yield ever reject.
      drawing = null;
      draining = false;
    }
  }

  return {
    handlers: {
      'prepare-raster': async (request) => {
        // The client drops a late answer to an aborted prepare: build nothing it would only release.
        if (c.isCancelled(request.id)) {
          fail(request.id, 'cancelled', 'request superseded');
          return;
        }
        try {
          const raster = prepareRaster(request.spec);
          rasters.set(request.id, raster);
          c.post(
            {
              bounds: raster.bounds,
              id: request.id,
              rasterId: request.id,
              type: 'raster-ready',
            },
            [],
          );
        } catch (error) {
          failWith(request.id, error);
        }
      },
      'raster-tile': (request) =>
        new Promise<void>((resolve) => {
          queue.push({ done: resolve, request });
          if (!draining) void drain();
        }),
      'release-raster': async (request) => {
        rasters.delete(request.rasterId);
        if (drawing?.rasterId === request.rasterId) await drawing.posted;
        c.post(
          {
            id: request.id,
            rasterId: request.rasterId,
            type: 'raster-released',
          },
          [],
        );
      },
    },
    version: 'atlas-raster-v1',
  };
}

/** The worker's `toBitmap`: the raster's own bytes as an unflipped, unpremultiplied bitmap. */
export function imageDataBitmap(raster: TileRaster): Promise<ImageBitmap> {
  return createImageBitmap(
    new ImageData(raster.rgba, RASTER_TILE_SIZE, RASTER_TILE_SIZE),
    BITMAP_OPTIONS,
  );
}
