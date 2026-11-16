/**
 * The source height under a point of a terrain mesh, for terrain draping design, "Exaggeration"
 * (#483): the ground under the draped observations and the highlight follows a relief change from
 * it without a pick (`ground-points.ts`).
 *
 * Cesium World Terrain's tiles are quantized meshes, and Cesium 1.145's
 * `QuantizedMeshTerrainData.interpolateHeight` cannot give that height for a tile drawn with its
 * own mesh: `createMesh` frees the quantized vertices it reads before the mesh exists, and the
 * path it takes once the mesh exists compares the point's u, v scaled to 32,767 with the mesh's
 * texture coordinates in [0, 1], so it scans every triangle and finds none (pinned in
 * atlas-cesium-internals.test.ts). The height is read from the mesh instead, as that path means
 * to: the triangle whose texture coordinates hold the point, the skirts left out, and its
 * vertices' source heights interpolated there. A vertex's source height is the encoding's
 * `decodeHeight`, which the mesh keeps before exaggeration (Cesium raises the drawn and picked
 * positions from it). Each mesh's texture coordinates and heights are decoded once, on its first
 * read, and kept while the mesh lives, so a later point costs one pass over its triangles. NaN
 * where no triangle holds the point.
 *
 * It reads Cesium 1.145's `TerrainMesh` (@private), pinned with the interpolation it replaces: a
 * mesh without those members is an error.
 */

import { Cartesian2, Math as CesiumMath, type Rectangle } from 'cesium';

/** The members of Cesium's `TerrainMesh` read here. */
interface TerrainMeshVertices {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  /** The leading indices, three a triangle, before the skirts'. */
  readonly indexCountWithoutSkirts: number;
  /** The leading vertices, before the skirts'. */
  readonly vertexCountWithoutSkirts: number;
  readonly encoding: {
    decodeTextureCoordinates(
      buffer: Float32Array,
      index: number,
      result: Cartesian2,
    ): Cartesian2;
    decodeHeight(buffer: Float32Array, index: number): number;
  };
}

/** A mesh's vertices without its skirts: texture coordinates and source heights. */
interface DecodedMesh {
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly height: Float64Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly indexCount: number;
}

const decodedMeshes = new WeakMap<object, DecodedMesh>();
const SCRATCH = new Cartesian2();
/** Cesium's own tolerance for a point on a triangle's edge (QuantizedMeshTerrainData.js). */
const EDGE_TOLERANCE = -1e-15;

function asTerrainMesh(mesh: object): TerrainMeshVertices {
  const m = mesh as Partial<TerrainMeshVertices>;
  if (
    !(m.vertices instanceof Float32Array) ||
    !(m.indices instanceof Uint16Array || m.indices instanceof Uint32Array) ||
    typeof m.indexCountWithoutSkirts !== 'number' ||
    typeof m.vertexCountWithoutSkirts !== 'number' ||
    typeof m.encoding?.decodeTextureCoordinates !== 'function' ||
    typeof m.encoding.decodeHeight !== 'function'
  )
    throw new Error(
      'a terrain mesh lacks the vertices, indices or encoding of Cesium 1.145’s TerrainMesh',
    );
  return m as TerrainMeshVertices;
}

function decode(mesh: object): DecodedMesh {
  let decoded = decodedMeshes.get(mesh);
  if (decoded) return decoded;
  const {
    encoding,
    indexCountWithoutSkirts,
    indices,
    vertexCountWithoutSkirts,
    vertices,
  } = asTerrainMesh(mesh);
  const u = new Float64Array(vertexCountWithoutSkirts);
  const v = new Float64Array(vertexCountWithoutSkirts);
  const height = new Float64Array(vertexCountWithoutSkirts);
  for (let i = 0; i < vertexCountWithoutSkirts; i += 1) {
    encoding.decodeTextureCoordinates(vertices, i, SCRATCH);
    u[i] = SCRATCH.x;
    v[i] = SCRATCH.y;
    height[i] = encoding.decodeHeight(vertices, i);
  }
  decoded = { height, indexCount: indexCountWithoutSkirts, indices, u, v };
  decodedMeshes.set(mesh, decoded);
  return decoded;
}

/**
 * The source height (metres, before exaggeration) of `mesh`, the mesh of the tile over
 * `rectangle`, under (`longitude`, `latitude`) in radians; NaN where no triangle holds it.
 */
export function meshSourceHeight(
  mesh: object,
  rectangle: Rectangle,
  longitude: number,
  latitude: number,
): number {
  const { height, indexCount, indices, u, v } = decode(mesh);
  const pu = CesiumMath.clamp(
    (longitude - rectangle.west) / rectangle.width,
    0,
    1,
  );
  const pv = CesiumMath.clamp(
    (latitude - rectangle.south) / rectangle.height,
    0,
    1,
  );
  for (let t = 0; t < indexCount; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];
    const u0 = u[i0];
    const u1 = u[i1];
    const u2 = u[i2];
    if (
      pu < Math.min(u0, u1, u2) ||
      pu > Math.max(u0, u1, u2) ||
      pv < Math.min(v[i0], v[i1], v[i2]) ||
      pv > Math.max(v[i0], v[i1], v[i2])
    )
      continue;
    const v0 = v[i0];
    const v1 = v[i1];
    const v2 = v[i2];
    const area = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (area === 0) continue;
    const b0 = ((v1 - v2) * (pu - u2) + (u2 - u1) * (pv - v2)) / area;
    const b1 = ((v2 - v0) * (pu - u2) + (u0 - u2) * (pv - v2)) / area;
    const b2 = 1 - b0 - b1;
    if (b0 >= EDGE_TOLERANCE && b1 >= EDGE_TOLERANCE && b2 >= EDGE_TOLERANCE)
      return b0 * height[i0] + b1 * height[i1] + b2 * height[i2];
  }
  return Number.NaN;
}
