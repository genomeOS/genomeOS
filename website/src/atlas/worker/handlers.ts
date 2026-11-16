/**
 * The Atlas data worker's complete handler registry (fast-load design §B.6.3): the data-tier
 * handlers plus the geometry handlers, which share the dispatcher's state, port and cancellation.
 * The grid's topology is warmed right after `grid-ready` (§B.6 "topology as soon as the grid arrives").
 *
 * The draped-raster requests (terrain draping design, "When it is active" and "How existing
 * features behave": Worker, #483) import the raster runtime on the first of them, once per worker
 * state, so it stays out of the worker's first load. It reads the geometry worker's cached
 * topology, its Natural Earth copy for the borders ("Per layer under World Terrain"), and the same
 * cancellation signals. A failed import fails the requests waiting on it as `internal` (design,
 * "Failure modes": the scene reverts to the smooth globe) and is not kept, so a later raster
 * request imports the runtime again.
 */

import type { DecodedGrid } from '../gosa/types';
import { DATA_HANDLERS } from './data-handlers';
import type {
  HandlerContext,
  HandlerRegistry,
  RequestHandler,
} from './dispatcher';
import {
  createGeometryWorker,
  messageChannelYield,
  type GeometryWorker,
} from './geometry-handlers';
import type { GeometryRequestType, RasterRequestType } from './protocol';
import type { RasterRuntime } from './raster-handlers';
import type { WorkerState } from './state';

interface GeometryRuntime {
  signals: Map<number, AbortSignal>;
  worker: GeometryWorker;
}

const runtimes = new WeakMap<WorkerState, GeometryRuntime>();
const rasterRuntimes = new WeakMap<WorkerState, Promise<RasterRuntime>>();

/** The grid a render tier was decoded against. */
function gridOfRender(
  state: WorkerState,
  artifactKey: string,
): DecodedGrid | undefined {
  const gridSha256 = state.renderGrids.get(artifactKey);
  return gridSha256 === undefined ? undefined : state.grids.get(gridSha256);
}

/** The geometry worker bound to this dispatcher's state and port. */
export function geometryRuntime(context: HandlerContext): GeometryRuntime {
  let runtime = runtimes.get(context.state);
  if (!runtime) {
    const { state } = context;
    const post = context.post;
    const signals = new Map<number, AbortSignal>();
    runtime = {
      signals,
      worker: createGeometryWorker({
        grid: (gridSha256) => state.grids.get(gridSha256),
        gridFor: (artifactKey) => gridOfRender(state, artifactKey),
        isCancelled: (id) => signals.get(id)?.aborted ?? false,
        now: () => performance.timeOrigin + performance.now(),
        post: (message, transfer) => post(message, transfer),
        render: (artifactKey) => state.renders.get(artifactKey),
        yieldToEventLoop: messageChannelYield(),
      }),
    };
    runtimes.set(state, runtime);
  }
  return runtime;
}

/** The raster runtime bound to this dispatcher's state and port, imported on first use. */
function rasterRuntime(context: HandlerContext): Promise<RasterRuntime> {
  const { state } = context;
  const cached = rasterRuntimes.get(state);
  if (cached) return cached;
  const post = context.post;
  // Request ids are unique per dispatcher, so the raster requests share the geometry signals.
  const { signals, worker } = geometryRuntime(context);
  const runtime: Promise<RasterRuntime> = import('./raster-handlers').then(
    ({ ATLAS_RASTERISERS, createRasterRuntime, imageDataBitmap }) =>
      createRasterRuntime(
        {
          gridFor: (artifactKey) => gridOfRender(state, artifactKey),
          isCancelled: (id) => signals.get(id)?.aborted ?? false,
          naturalEarth: worker.naturalEarth,
          now: () => performance.timeOrigin + performance.now(),
          post: (message, transfer) => post(message, transfer),
          prepared: worker.prepared,
          render: (artifactKey) => state.renders.get(artifactKey),
          toBitmap: imageDataBitmap,
          yieldToEventLoop: messageChannelYield(),
        },
        ATLAS_RASTERISERS,
      ),
    (error: unknown) => {
      // The worker lives as long as the page: a later raster request imports it again.
      if (rasterRuntimes.get(state) === runtime) rasterRuntimes.delete(state);
      throw error;
    },
  );
  rasterRuntimes.set(state, runtime);
  return runtime;
}

function geometry<K extends GeometryRequestType>(type: K): RequestHandler<K> {
  return async (request, context) => {
    const runtime = geometryRuntime(context);
    runtime.signals.set(context.id, context.signal);
    try {
      const handler = runtime.worker.handlers[type];
      await handler(request);
    } finally {
      runtime.signals.delete(context.id);
    }
  };
}

function raster<K extends RasterRequestType>(type: K): RequestHandler<K> {
  return async (request, context) => {
    const { signals } = geometryRuntime(context);
    // Before the import, so a cancel that lands while the runtime loads is seen.
    signals.set(context.id, context.signal);
    try {
      const handler = (await rasterRuntime(context)).handlers[type];
      await handler(request);
    } finally {
      signals.delete(context.id);
    }
  };
}

export const ATLAS_WORKER_HANDLERS: HandlerRegistry = {
  ...DATA_HANDLERS,
  'build-chunks': geometry('build-chunks'),
  'build-edges': geometry('build-edges'),
  'context-heights': geometry('context-heights'),
  'load-grid': async (request, context) => {
    await DATA_HANDLERS['load-grid'](request, context);
    geometryRuntime(context).worker.warmGrid(
      request.id,
      request.expect.gridSha256,
    );
  },
  'parse-context': geometry('parse-context'),
  'prepare-raster': raster('prepare-raster'),
  'raster-tile': raster('raster-tile'),
  recolour: geometry('recolour'),
  'release-raster': raster('release-raster'),
};
