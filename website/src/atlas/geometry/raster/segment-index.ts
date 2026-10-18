/**
 * The segment index the draped country borders query by tile (terrain draping design, "Per layer
 * under World Terrain": borders as the `atlas-borders` layer; "Failure modes": antimeridian, #483).
 *
 * The rings' segments sit in `SEGMENT_BUCKET_DEGREES` buckets over the world in CSR form, a segment
 * in every bucket its box meets, so a border tile reads only the segments near it. Building the index
 * checks every ring and vertex, and a segment that jumps the antimeridian (more than 180° of
 * longitude) is an error: no border is dropped silently. A query lists each segment once, ascending,
 * and folds a rectangle that passes ±180° back onto the world; a malformed rectangle is an error.
 * `line-raster.ts` re-exports it; like every `geometry/raster/*` module it loads only through the
 * raster runtime's `import()`. Nothing here is stochastic.
 */

import type { DegreeRectangle } from './types';

/** Side of a segment index bucket, in degrees. */
export const SEGMENT_BUCKET_DEGREES = 1;

/** Segments of interleaved lon, lat rings by rectangle. */
export interface SegmentIndex {
  /** Each segment whose box meets `r`, or `r` shifted ∓360° where it passes ±180°, once and
   * ascending; `out` is reused when given. Segment v joins vertex v to vertex v + 1 of its ring. A
   * rectangle with west > east, south > north or a NaN edge is an error, never an empty answer. */
  segmentsIn(r: DegreeRectangle, out?: number[]): number[];
}

const BUCKET_COLUMNS = 360 / SEGMENT_BUCKET_DEGREES;
const BUCKET_ROWS = 180 / SEGMENT_BUCKET_DEGREES;

function bucketColumn(lon: number): number {
  const column = Math.floor((lon + 180) / SEGMENT_BUCKET_DEGREES);
  return Math.min(BUCKET_COLUMNS - 1, Math.max(0, column));
}

function bucketRow(lat: number): number {
  const row = Math.floor((lat + 90) / SEGMENT_BUCKET_DEGREES);
  return Math.min(BUCKET_ROWS - 1, Math.max(0, row));
}

/** Calls `visit(v)` for each segment v of the rings: vertex v to v + 1 within one ring. */
function forEachSegment(
  ringOffsets: Uint32Array,
  visit: (v: number) => void,
): void {
  for (let ring = 0; ring + 1 < ringOffsets.length; ring += 1)
    for (let v = ringOffsets[ring]; v + 1 < ringOffsets[ring + 1]; v += 1)
      visit(v);
}

/** The border rings' segments in `SEGMENT_BUCKET_DEGREES` buckets over the world, in CSR form: a
 * segment sits in every bucket its box meets. Every ring must hold at least two vertices, each a
 * finite WGS84 lon, lat, and no segment may jump the antimeridian (more than 180° of longitude). */
export function buildSegmentIndex(
  lonLat: Float64Array,
  ringOffsets: Uint32Array,
): SegmentIndex {
  const vertices = lonLat.length / 2;
  if (
    !Number.isInteger(vertices) ||
    ringOffsets.length === 0 ||
    ringOffsets[0] !== 0 ||
    ringOffsets[ringOffsets.length - 1] !== vertices
  )
    throw new Error(
      `border rings must run from vertex 0 to the last of ${vertices} lon, lat vertices`,
    );
  for (let ring = 0; ring + 1 < ringOffsets.length; ring += 1)
    if (ringOffsets[ring + 1] < ringOffsets[ring] + 2)
      throw new Error(`border ring ${ring} has fewer than two vertices`);
  for (let v = 0; v < vertices; v += 1) {
    const lon = lonLat[2 * v];
    const lat = lonLat[2 * v + 1];
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90))
      throw new Error(
        `border vertex ${v} must be finite WGS84 lon, lat degrees, got ${lon}, ${lat}`,
      );
  }
  const buckets = (v: number, visit: (bucket: number) => void) => {
    const [lon0, lat0] = [lonLat[2 * v], lonLat[2 * v + 1]];
    const [lon1, lat1] = [lonLat[2 * v + 2], lonLat[2 * v + 3]];
    if (Math.abs(lon1 - lon0) > 180)
      throw new Error(
        `border segment jumps the antimeridian: vertex ${v} at ${lon0}° to vertex ${v + 1} at ${lon1}°`,
      );
    const lastColumn = bucketColumn(Math.max(lon0, lon1));
    const lastRow = bucketRow(Math.max(lat0, lat1));
    for (let row = bucketRow(Math.min(lat0, lat1)); row <= lastRow; row += 1)
      for (
        let column = bucketColumn(Math.min(lon0, lon1));
        column <= lastColumn;
        column += 1
      )
        visit(row * BUCKET_COLUMNS + column);
  };
  const offsets = new Uint32Array(BUCKET_COLUMNS * BUCKET_ROWS + 1);
  forEachSegment(ringOffsets, (v) =>
    buckets(v, (bucket) => {
      offsets[bucket + 1] += 1;
    }),
  );
  for (let bucket = 0; bucket < BUCKET_COLUMNS * BUCKET_ROWS; bucket += 1)
    offsets[bucket + 1] += offsets[bucket];
  const ids = new Uint32Array(offsets[BUCKET_COLUMNS * BUCKET_ROWS]);
  const fill = offsets.slice(0, -1);
  forEachSegment(ringOffsets, (v) =>
    buckets(v, (bucket) => {
      ids[fill[bucket]] = v;
      fill[bucket] += 1;
    }),
  );
  // A segment is listed once per query: its stamp holds the query that listed it.
  const stamp = new Uint32Array(vertices);
  let query = 0;
  return {
    segmentsIn(r, out = []) {
      if (!(r.west <= r.east && r.south <= r.north))
        throw new Error(
          `border segments need a rectangle with west ≤ east and south ≤ north, not ` +
            `${JSON.stringify(r)}`,
        );
      out.length = 0;
      if (query === 0xffffffff) {
        stamp.fill(0);
        query = 0;
      }
      query += 1;
      const south = Math.max(-90, r.south);
      const north = Math.min(90, r.north);
      const collect = (westOf: number, eastOf: number) => {
        const west = Math.max(-180, westOf);
        const east = Math.min(180, eastOf);
        if (!(west <= east && south <= north)) return;
        for (let row = bucketRow(south); row <= bucketRow(north); row += 1)
          for (
            let column = bucketColumn(west);
            column <= bucketColumn(east);
            column += 1
          ) {
            const bucket = row * BUCKET_COLUMNS + column;
            for (let k = offsets[bucket]; k < offsets[bucket + 1]; k += 1) {
              const v = ids[k];
              if (stamp[v] === query) continue;
              const lon0 = lonLat[2 * v];
              const lon1 = lonLat[2 * v + 2];
              const lat0 = lonLat[2 * v + 1];
              const lat1 = lonLat[2 * v + 3];
              if (
                Math.min(lon0, lon1) > east ||
                Math.max(lon0, lon1) < west ||
                Math.min(lat0, lat1) > north ||
                Math.max(lat0, lat1) < south
              )
                continue;
              stamp[v] = query;
              out.push(v);
            }
          }
      };
      collect(r.west, r.east);
      if (r.west < -180) collect(r.west + 360, r.east + 360);
      if (r.east > 180) collect(r.west - 360, r.east - 360);
      return out.sort((p, q) => p - q);
    },
  };
}
