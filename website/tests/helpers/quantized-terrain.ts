/**
 * Real Cesium 1.145 quantized-mesh terrain tiles (`QuantizedMeshTerrainData`, the format of Cesium
 * World Terrain) for unit tests of the ground under the draped observations (terrain draping
 * design, "Exaggeration", #483). Cesium builds a quantized tile's mesh in a web worker
 * (`createVerticesFromQuantizedTerrainMesh`); `runQuantizedMeshWorker` answers that task with the
 * same worker module run on this thread, so `createMesh` makes Cesium's own mesh.
 */

import path from 'node:path';

import {
  BoundingSphere,
  Cartesian3,
  Ellipsoid,
  QuantizedMeshTerrainData,
  Rectangle,
  type TilingScheme,
} from 'cesium';
import { vi } from 'vitest';

/** Cesium's largest quantized coordinate. */
const MAX_SHORT = 32_767;

const WORKER = path.resolve(
  import.meta.dirname,
  '../../node_modules/@cesium/engine/Source/Workers/createVerticesFromQuantizedTerrainMesh.js',
);

type WorkerHandler = (event: { data: object }) => Promise<void>;
let handler: Promise<WorkerHandler> | undefined;

/** The mesh worker's message handler, which it installs as `self.onmessage` on import. */
function meshWorker(): Promise<WorkerHandler> {
  handler ??= (async () => {
    vi.stubGlobal('self', globalThis);
    await import(/* @vite-ignore */ WORKER);
    return (globalThis as unknown as { onmessage: WorkerHandler }).onmessage;
  })();
  return handler;
}

/** Whether a TaskProcessor task is a quantized tile's mesh. */
export function isQuantizedMeshTask(parameters: unknown): boolean {
  return (
    typeof parameters === 'object' &&
    parameters !== null &&
    'quantizedVertices' in parameters
  );
}

/** Runs one `createVerticesFromQuantizedTerrainMesh` task on this thread, as its worker would. */
export async function runQuantizedMeshTask(
  parameters: object,
): Promise<unknown> {
  const onMessage = await meshWorker();
  let response: { result?: unknown; error?: unknown } | undefined;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('postMessage', (message: typeof response) => {
    response = message;
  });
  await onMessage({
    data: { canTransferArrayBuffer: false, id: 1, parameters },
  });
  if (response === undefined || response.error !== undefined)
    throw new Error(
      `the quantized mesh worker failed: ${JSON.stringify(response?.error)}`,
    );
  return response.result;
}

/**
 * A quantized tile at `x`, `y`, `level` of `tilingScheme`: `samples` × `samples` vertices on a
 * regular grid, two triangles a cell, each vertex at `heightAt` (metres, from radians).
 */
export function quantizedTile(
  tilingScheme: TilingScheme,
  x: number,
  y: number,
  level: number,
  heightAt: (longitude: number, latitude: number) => number,
  samples = 33,
): QuantizedMeshTerrainData {
  const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
  const count = samples * samples;
  const heights = new Float64Array(count);
  for (let row = 0; row < samples; row += 1)
    for (let column = 0; column < samples; column += 1)
      heights[row * samples + column] = heightAt(
        rectangle.west + (column / (samples - 1)) * rectangle.width,
        rectangle.south + (row / (samples - 1)) * rectangle.height,
      );
  const minimumHeight = Math.min(...heights);
  const maximumHeight = Math.max(minimumHeight + 1, ...heights);
  const quantized = new Uint16Array(3 * count);
  for (let row = 0; row < samples; row += 1)
    for (let column = 0; column < samples; column += 1) {
      const i = row * samples + column;
      quantized[i] = Math.round((column / (samples - 1)) * MAX_SHORT);
      quantized[count + i] = Math.round((row / (samples - 1)) * MAX_SHORT);
      quantized[2 * count + i] = Math.round(
        ((heights[i] - minimumHeight) / (maximumHeight - minimumHeight)) *
          MAX_SHORT,
      );
    }
  const indices = new Uint16Array(6 * (samples - 1) ** 2);
  let at = 0;
  for (let row = 0; row < samples - 1; row += 1)
    for (let column = 0; column < samples - 1; column += 1) {
      const sw = row * samples + column;
      const se = sw + 1;
      const nw = sw + samples;
      const ne = nw + 1;
      indices.set([sw, se, nw, se, ne, nw], at);
      at += 6;
    }
  // Typed arrays, as Cesium's terrain providers hand over; its declarations say number[].
  const edge = (keep: (column: number, row: number) => boolean) =>
    Uint16Array.from(
      Array.from({ length: count }, (_, i) => i).filter((i) =>
        keep(i % samples, Math.floor(i / samples)),
      ),
    ) as unknown as number[];
  const center = Rectangle.center(rectangle);
  return new QuantizedMeshTerrainData({
    boundingSphere: BoundingSphere.fromRectangle3D(
      rectangle,
      Ellipsoid.WGS84,
      maximumHeight,
    ),
    childTileMask: 15,
    eastIndices: edge((column) => column === samples - 1),
    eastSkirtHeight: 100,
    horizonOcclusionPoint: Cartesian3.fromRadians(
      center.longitude,
      center.latitude,
      maximumHeight + 10_000,
    ),
    indices,
    maximumHeight,
    minimumHeight,
    northIndices: edge((_, row) => row === samples - 1),
    northSkirtHeight: 100,
    quantizedVertices: quantized,
    southIndices: edge((_, row) => row === 0),
    southSkirtHeight: 100,
    westIndices: edge((column) => column === 0),
    westSkirtHeight: 100,
  });
}

/** Cesium's `TerrainMesh` (@private, so undeclared), as far as these tests read it. */
export interface QuantizedTerrainMesh {
  readonly encoding: {
    decodeHeight(buffer: Float32Array, index: number): number;
  };
}

/** `QuantizedMeshTerrainData.createMesh`, which Cesium's declarations leave out (@private). */
interface MeshCreation {
  createMesh(options: {
    exaggeration: number;
    exaggerationRelativeHeight: number;
    level: number;
    throttle: boolean;
    tilingScheme: TilingScheme;
    x: number;
    y: number;
  }): Promise<QuantizedTerrainMesh> | undefined;
}

/** Cesium's own mesh of `data`, drawn `exaggeration` times from sea level. */
export async function quantizedMesh(
  data: QuantizedMeshTerrainData,
  tilingScheme: TilingScheme,
  x: number,
  y: number,
  level: number,
  exaggeration: number,
): Promise<QuantizedTerrainMesh> {
  const mesh = await (data as unknown as MeshCreation).createMesh({
    exaggeration,
    exaggerationRelativeHeight: 0,
    level,
    throttle: false,
    tilingScheme,
    x,
    y,
  });
  if (mesh === undefined) throw new Error('Cesium postponed the mesh');
  return mesh;
}
