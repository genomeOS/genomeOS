/**
 * Grid rows by rectangle for the draped Atlas rasters (terrain draping design, "Per layer under
 * World Terrain" and "Failure modes": polar and antimeridian cells take a ±360° shifted copy, #483).
 *
 * Each row gets a box from its topology corners, each unwrapped to within 180° of the row centre's
 * longitude and padded by 10% of the box's own extent on every side. The pad covers the class III
 * distortion points of `cellToBoundary`, which the topology does not hold: over every res-1 and
 * res-3 cell they lie under 5.1% of the extent outside the corners. A row whose unwrapped corners
 * span more than 180° of longitude holds a pole: its box spans every longitude, from its lowest
 * (or highest) corner, padded the same way, to the pole. A box past ±180° is entered once more,
 * shifted by ∓360°, into 1° buckets, so tiles on both sides of the antimeridian find the row.
 *
 * `rowsIn` tests every candidate's box against the rectangle and its ±360° copies, so a rectangle
 * grown past ±180° finds the rows on the far side. Nothing here is stochastic, and no row is
 * dropped: a row without finite corners throws. The surface raster reads the same boxes
 * (`rowBox`) to skip a row with no texel centre in a tile.
 */

import type { GridTopology } from '../topology';
import { turnsNear } from './tiling';
import type { DegreeRectangle, GridIndex } from './types';

/** Fraction of a box's own extent added on every side. */
const BOX_PAD = 0.1;
/** 1° buckets over the globe. */
const BUCKET_COLUMNS = 360;
const BUCKET_ROWS = 180;

function bucketColumn(lon: number): number {
  return Math.min(BUCKET_COLUMNS - 1, Math.floor(lon + 180));
}

function bucketRow(lat: number): number {
  return Math.min(BUCKET_ROWS - 1, Math.max(0, Math.floor(lat + 90)));
}

/** One row's box in degrees; `west`/`east` may pass ±180° by less than a turn. */
export interface RowBox extends DegreeRectangle {
  /** The row's unwrapped corners span more than 180° of longitude: it holds a pole. */
  polar: boolean;
}

/** Row `row`'s box: its corners unwrapped to within 180° of its centre and padded by `BOX_PAD`, or,
 * for a pole-holding row, every longitude from its padded lowest (or highest) corner to the pole.
 * Throws for a row without finite corners. */
export function rowBox(topology: GridTopology, row: number): RowBox {
  const { cornerIds, cornerOffsets, vertexLat, vertexLon } = topology;
  const near = topology.centreLon[row];
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let k = cornerOffsets[row]; k < cornerOffsets[row + 1]; k += 1) {
    const id = cornerIds[k];
    const lon = vertexLon[id] + 360 * turnsNear(vertexLon[id], near);
    const lat = vertexLat[id];
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (![west, east, south, north].every(Number.isFinite))
    throw new Error(`grid row ${row} has no finite corners to index`);
  const polar = east - west > 180;
  if (polar) {
    west = -180;
    east = 180;
    if (topology.centreLat[row] > 0) {
      south -= BOX_PAD * (90 - south);
      north = 90;
    } else {
      north += BOX_PAD * (north + 90);
      south = -90;
    }
  } else {
    const padLon = BOX_PAD * (east - west);
    const padLat = BOX_PAD * (north - south);
    west -= padLon;
    east += padLon;
    south -= padLat;
    north += padLat;
  }
  return {
    east,
    north: Math.min(90, north),
    polar,
    south: Math.max(-90, south),
    west,
  };
}

/** Per-row boxes in degrees; `west`/`east` may pass ±180° by less than a turn. */
interface RowBoxes {
  west: Float64Array;
  south: Float64Array;
  east: Float64Array;
  north: Float64Array;
  /** 1 for a row that holds a pole or whose box passes ±180°. */
  wraps: Uint8Array;
}

function rowBoxes(topology: GridTopology): RowBoxes {
  const { n } = topology;
  const boxes: RowBoxes = {
    east: new Float64Array(n),
    north: new Float64Array(n),
    south: new Float64Array(n),
    west: new Float64Array(n),
    wraps: new Uint8Array(n),
  };
  for (let row = 0; row < n; row += 1) {
    const { east, north, south, west } = rowBox(topology, row);
    boxes.west[row] = west;
    boxes.east[row] = east;
    boxes.south[row] = south;
    boxes.north[row] = north;
    boxes.wraps[row] = east - west >= 360 || west < -180 || east > 180 ? 1 : 0;
  }
  return boxes;
}

/** Calls `visit` with each bucket the row's box, or its shifted copy, covers. */
function visitBuckets(
  boxes: RowBoxes,
  row: number,
  visit: (bucket: number) => void,
): void {
  const first = bucketRow(boxes.south[row]);
  const last = bucketRow(boxes.north[row]);
  const west = boxes.west[row];
  const east = boxes.east[row];
  const enter = (from: number, to: number) => {
    for (let r = first; r <= last; r += 1)
      for (let c = bucketColumn(from); c <= bucketColumn(to); c += 1)
        visit(r * BUCKET_COLUMNS + c);
  };
  enter(Math.max(-180, west), Math.min(180, east));
  if (west < -180) enter(west + 360, 180);
  if (east > 180) enter(-180, east - 360);
}

/** True when the row's box, or a ±360° copy of it, meets `r` (edges included). */
function overlaps(boxes: RowBoxes, row: number, r: DegreeRectangle): boolean {
  if (boxes.south[row] > r.north || boxes.north[row] < r.south) return false;
  const west = boxes.west[row];
  const east = boxes.east[row];
  return (
    (west <= r.east && east >= r.west) ||
    (west + 360 <= r.east && east + 360 >= r.west) ||
    (west - 360 <= r.east && east - 360 >= r.west)
  );
}

export function buildGridIndex(topology: GridTopology): GridIndex {
  const boxes = rowBoxes(topology);
  const buckets = BUCKET_COLUMNS * BUCKET_ROWS;
  const offsets = new Uint32Array(buckets + 1);
  for (let row = 0; row < topology.n; row += 1)
    visitBuckets(boxes, row, (bucket) => {
      offsets[bucket + 1] += 1;
    });
  for (let bucket = 0; bucket < buckets; bucket += 1)
    offsets[bucket + 1] += offsets[bucket];
  const entries = new Uint32Array(offsets[buckets]);
  const cursor = offsets.slice(0, buckets);
  for (let row = 0; row < topology.n; row += 1)
    visitBuckets(boxes, row, (bucket) => {
      entries[cursor[bucket]] = row;
      cursor[bucket] += 1;
    });

  const stamps = new Uint32Array(topology.n);
  let stamp = 0;

  return {
    bounds(drawn) {
      let any = false;
      let wraps = false;
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (let row = 0; row < topology.n; row += 1) {
        if (!drawn(row)) continue;
        any = true;
        if (boxes.south[row] < south) south = boxes.south[row];
        if (boxes.north[row] > north) north = boxes.north[row];
        if (boxes.wraps[row] === 1) wraps = true;
        else {
          if (boxes.west[row] < west) west = boxes.west[row];
          if (boxes.east[row] > east) east = boxes.east[row];
        }
      }
      if (!any) return null;
      return wraps
        ? { east: 180, north, south, west: -180 }
        : { east, north, south, west };
    },

    rowsIn(r, out = []) {
      if (!(r.west <= r.east && r.south <= r.north))
        throw new Error(
          `grid rows need a rectangle with west ≤ east and south ≤ north, not ` +
            `${JSON.stringify(r)}`,
        );
      out.length = 0;
      stamp += 1;
      if (stamp === 0xffffffff) {
        stamps.fill(0);
        stamp = 1;
      }
      const first = bucketRow(r.south);
      const last = bucketRow(r.north);
      const allColumns = r.east - r.west >= 360;
      const from = allColumns ? 0 : Math.floor(r.west + 180);
      const to = allColumns ? BUCKET_COLUMNS - 1 : Math.floor(r.east + 180);
      for (
        let bucketRowIndex = first;
        bucketRowIndex <= last;
        bucketRowIndex += 1
      )
        for (let c = from; c <= to; c += 1) {
          const column =
            ((c % BUCKET_COLUMNS) + BUCKET_COLUMNS) % BUCKET_COLUMNS;
          const bucket = bucketRowIndex * BUCKET_COLUMNS + column;
          for (let k = offsets[bucket]; k < offsets[bucket + 1]; k += 1) {
            const row = entries[k];
            if (stamps[row] === stamp) continue;
            stamps[row] = stamp;
            if (overlaps(boxes, row, r)) out.push(row);
          }
        }
      return out.sort((a, b) => a - b);
    },
  };
}
