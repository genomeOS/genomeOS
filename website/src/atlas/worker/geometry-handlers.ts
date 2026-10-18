/** Geometry request handlers for the Atlas data worker (fast-load spec
 * 2026-10-07 §B.6.3, §B.6.5, §B.6.9, §B.6.13; step timings §B.1).
 *
 * Pure orchestration over the Cesium-free geometry modules: one transferable
 * `chunk` message per chunk in camera order (anchors ride on the first), a
 * yield between chunks so `cancel` can land, and topology plus the chunk plan
 * cached per grid. Recolour reuses the cached topology and vertex means. The
 * draped rasters share that cache through `prepared`, and the borders copy that
 * `parse-context` keeps through `naturalEarth` (terrain draping design, "How
 * existing features behave": Worker; "Per layer under World Terrain": borders,
 * #483).
 */

import type { DecodedGrid, DecodedRender } from '../gosa/types';
import { observationAnchors } from '../geometry/anchors';
import {
  orderChunksForCamera,
  planChunks,
  type ChunkPlan,
} from '../geometry/chunks';
import { buildEdgeChunk, edgeCapacity } from '../geometry/edge-buffers';
import {
  naturalEarthHeights,
  type NaturalEarthBuffers,
} from '../geometry/natural-earth';
import { decodeNaturalEarth } from '../geometry/natural-earth-codec';
import { buildSurfaceChunk, type MeshInput } from '../geometry/surface-buffers';
import { buildSupportChunk } from '../geometry/support-buffers';
import { buildGridTopology, type GridTopology } from '../geometry/topology';
import type { SurfaceGeometry } from '../url-state';
import type { Metric, PaletteId } from '../visual-encoding';
import type {
  ChunkMessage,
  GeometryRequestType,
  GeometryResponse,
  GeometryStepName,
  WorkerRequestOf,
} from './protocol';

export interface GeometryWorkerContext {
  post(message: GeometryResponse, transfer: Transferable[]): void;
  /** Milliseconds on the epoch clock (`performance.timeOrigin + performance.now()`); the client
   * converts step timings to the page time origin. */
  now(): number;
  isCancelled(id: number): boolean;
  grid(gridSha256: string): DecodedGrid | undefined;
  /** The grid a render tier was decoded against (`WorkerState.renderGrids`). */
  gridFor(artifactKey: string): DecodedGrid | undefined;
  render(artifactKey: string): DecodedRender | undefined;
  yieldToEventLoop(): Promise<void>;
}

export interface PreparedGrid {
  topology: GridTopology;
  plan: ChunkPlan;
}

/** One handler per geometry request type. A mapped type, so indexing it with a generic request
 * type K gives the handler for `WorkerRequestOf<K>` (the registry adapter in handlers.ts). */
export type GeometryHandlers = {
  [K in GeometryRequestType]: (request: WorkerRequestOf<K>) => Promise<void>;
};

/** Every distinct ArrayBuffer behind the typed arrays, each listed once. */
export function transferablesOf(
  ...arrays: readonly (ArrayBufferView | null | undefined)[]
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const array of arrays)
    if (array) buffers.add(array.buffer as ArrayBuffer);
  return [...buffers];
}

function chunkTransferables(message: ChunkMessage): ArrayBuffer[] {
  const { surface, support, anchors } = message;
  return transferablesOf(
    surface.positions,
    surface.normals,
    surface.elevationNormals,
    surface.colors,
    surface.heights,
    surface.values,
    surface.cellCentres,
    surface.indices,
    support.unknown?.positions,
    support.unknown?.normals,
    support.unknown?.st,
    support.unknown?.cellCentres,
    support.unknown?.indices,
    ...support.priorDominated.flatMap(({ buffers }) => [
      buffers.positions,
      buffers.normals,
      buffers.st,
      buffers.cellCentres,
      buffers.indices,
    ]),
    anchors?.heights,
    anchors?.triangles,
  );
}

class MissingInputError extends Error {}

export interface GeometryWorker {
  handlers: GeometryHandlers;
  /** The cached topology and chunk plan of a loaded grid, built (untimed) when absent; undefined
   * when the grid is not loaded. The raster runtime reads it, so both share one topology. */
  prepared(gridSha256: string): PreparedGrid | undefined;
  /** Builds and caches topology and the chunk plan as soon as a grid decodes. */
  warmGrid(id: number, gridSha256: string): void;
  /** The Natural Earth copy `parse-context` keeps (its posted buffers are transferred); null
   * before the borders are parsed. The raster runtime draws the draped borders from it. */
  naturalEarth(): NaturalEarthBuffers | null;
}

export function createGeometryWorker(
  context: GeometryWorkerContext,
): GeometryWorker {
  const preparedGrids = new Map<string, PreparedGrid>();
  let naturalEarth: NaturalEarthBuffers | null = null;

  function build(gridSha256: string, grid: DecodedGrid): PreparedGrid {
    const topology = buildGridTopology(grid);
    const entry = { plan: planChunks(grid, topology), topology };
    preparedGrids.set(gridSha256, entry);
    return entry;
  }

  function timing(
    id: number,
    step: GeometryStepName,
    chunk: number | null,
    artifactKey: string | null,
    start: number,
  ): void {
    context.post(
      {
        artifactKey,
        chunk,
        endEpochMs: context.now(),
        id,
        startEpochMs: start,
        step,
        type: 'step-timing',
      },
      [],
    );
  }

  function prepare(
    id: number,
    gridSha256: string,
  ): { grid: DecodedGrid } & PreparedGrid {
    const grid = context.grid(gridSha256);
    if (!grid) throw new MissingInputError(`grid ${gridSha256} is not loaded`);
    let entry = preparedGrids.get(gridSha256);
    if (!entry) {
      const start = context.now();
      entry = build(gridSha256, grid);
      timing(id, 'topology', null, null, start);
    }
    return { grid, ...entry };
  }

  function meshInput(
    id: number,
    request: {
      gridSha256: string;
      artifactKey: string;
      metric: Metric;
      palette: PaletteId;
      geometry: SurfaceGeometry;
    },
  ): { input: MeshInput; plan: ChunkPlan } {
    const { grid, plan, topology } = prepare(id, request.gridSha256);
    const render = context.render(request.artifactKey);
    if (!render)
      throw new MissingInputError(
        `render tier ${request.artifactKey} is not loaded`,
      );
    return {
      input: {
        domain: render.artifact.metric_domains[request.metric],
        geometry: request.geometry,
        grid,
        palette: request.palette,
        support: render.support,
        topology,
        values: render[request.metric],
      },
      plan,
    };
  }

  async function guarded(
    id: number,
    work: () => Promise<void>,
    code: 'internal' | 'validation' = 'internal',
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      context.post(
        {
          code: error instanceof MissingInputError ? 'internal' : code,
          gosaCode: null,
          id,
          message: error instanceof Error ? error.message : String(error),
          type: 'error',
        },
        [],
      );
    }
  }

  function cancelled(id: number): boolean {
    if (!context.isCancelled(id)) return false;
    context.post(
      {
        code: 'cancelled',
        gosaCode: null,
        id,
        message: 'request superseded',
        type: 'error',
      },
      [],
    );
    return true;
  }

  async function streamChunks(
    id: number,
    artifactKey: string,
    input: MeshInput,
    plan: ChunkPlan,
    order: readonly number[],
    points: Float64Array | null,
  ): Promise<void> {
    const anchors = points ? observationAnchors(input, points) : null;
    for (let index = 0; index < order.length; index += 1) {
      if (cancelled(id)) return;
      const chunk = plan.chunks[order[index]];
      const meshStart = context.now();
      const surface = buildSurfaceChunk(input, chunk);
      timing(id, 'mesh', chunk.id, artifactKey, meshStart);
      const supportStart = context.now();
      const support = buildSupportChunk(input, chunk);
      timing(id, 'support', chunk.id, artifactKey, supportStart);
      const message: ChunkMessage = {
        anchors: index === 0 ? anchors : null,
        artifactKey,
        chunk: chunk.id,
        id,
        index,
        seam: chunk.seam,
        support,
        surface,
        total: order.length,
        type: 'chunk',
      };
      context.post(message, chunkTransferables(message));
      await context.yieldToEventLoop();
    }
    if (cancelled(id)) return;
    context.post(
      { artifactKey, id, total: order.length, type: 'chunks-done' },
      [],
    );
  }

  const handlers: GeometryHandlers = {
    'build-chunks': (request) =>
      guarded(request.id, async () => {
        const { input, plan } = meshInput(request.id, request);
        await streamChunks(
          request.id,
          request.artifactKey,
          input,
          plan,
          orderChunksForCamera(plan, request.lookAt),
          request.observationPoints,
        );
      }),
    recolour: (request) =>
      guarded(request.id, async () => {
        const { input, plan } = meshInput(request.id, request);
        await streamChunks(
          request.id,
          request.artifactKey,
          input,
          plan,
          plan.chunks.map((chunk) => chunk.id),
          null,
        );
      }),
    'build-edges': (request) =>
      guarded(request.id, async () => {
        const { input, plan } = meshInput(request.id, request);
        const order = orderChunksForCamera(plan, request.lookAt);
        const built = order.map((chunkId) =>
          buildEdgeChunk(
            input,
            plan.chunks[chunkId],
            request.edgeColor,
            request.factor,
          ),
        );
        const { primitiveCountMax, vertexCountMax } = edgeCapacity(built);
        for (let index = 0; index < built.length; index += 1) {
          if (cancelled(request.id)) return;
          const edges = built[index];
          context.post(
            {
              artifactKey: request.artifactKey,
              edges,
              id: request.id,
              index,
              primitiveCountMax,
              total: built.length,
              type: 'edges-chunk',
              vertexCountMax,
            },
            transferablesOf(
              edges.ringOffsets,
              edges.positions,
              edges.basePositions,
              edges.baseHeights,
              edges.normals,
              edges.colors,
            ),
          );
          await context.yieldToEventLoop();
        }
        if (cancelled(request.id)) return;
        context.post(
          {
            artifactKey: request.artifactKey,
            id: request.id,
            total: built.length,
            type: 'edges-done',
          },
          [],
        );
      }),
    'parse-context': (request) =>
      guarded(
        request.id,
        async () => {
          const buffers = decodeNaturalEarth(request.bytes);
          naturalEarth = {
            labels: buffers.labels,
            lonLat: buffers.lonLat.slice(),
            ringOffsets: buffers.ringOffsets.slice(),
          };
          context.post(
            { buffers, id: request.id, type: 'context-ready' },
            transferablesOf(buffers.ringOffsets, buffers.lonLat),
          );
        },
        'validation',
      ),
    'context-heights': (request) =>
      guarded(request.id, async () => {
        if (!naturalEarth)
          throw new MissingInputError('Natural Earth context is not parsed');
        const grid = context.gridFor(request.artifactKey);
        const render = context.render(request.artifactKey);
        if (!grid || !render)
          throw new MissingInputError(
            `surface ${request.artifactKey} is not loaded`,
          );
        const { borderHeights, labelHeights } = naturalEarthHeights(
          naturalEarth,
          {
            domain: render.artifact.metric_domains[request.metric],
            grid,
            support: render.support,
            values: render[request.metric],
          },
        );
        context.post(
          {
            borderHeights,
            id: request.id,
            labelHeights,
            type: 'context-heights-ready',
          },
          transferablesOf(borderHeights, labelHeights),
        );
      }),
  };

  return {
    handlers,
    // These two read no `this`, so the raster context may hold them unbound.
    naturalEarth: () => naturalEarth,
    prepared: (gridSha256) => {
      const grid = context.grid(gridSha256);
      if (!grid) return undefined;
      return preparedGrids.get(gridSha256) ?? build(gridSha256, grid);
    },
    warmGrid(id, gridSha256) {
      prepare(id, gridSha256);
    },
  };
}

/** A macrotask yield without the nested-setTimeout 4 ms clamp (§B.6.9). */
export function messageChannelYield(): () => Promise<void> {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  // Node keeps a listening port alive; browsers have no unref.
  (channel.port1 as { unref?: () => void }).unref?.();
  (channel.port2 as { unref?: () => void }).unref?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}
