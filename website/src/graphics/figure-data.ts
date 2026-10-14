/** The committed figure binaries: layout, encoder and decoder (site redesign spec §5, #454).
 *
 * `scripts/build-site-figures.mjs` writes them from the pinned HbS (rs334) v3 artifact; figures
 * decode them in the browser. One layout serves both, so they cannot disagree. Little-endian.
 *
 *   header   12 B   magic "GOSF", uint8 version, uint8 kind, uint16 record bytes, uint32 count
 *   areas    34 B   6 × (int16 lon × 100, int16 lat × 100), uint16 mean, lo, hi (× 10⁴;
 *                   0xFFFF = no value), uint16 distance to the nearest survey (km),
 *                   uint8 support, uint8 evidence tier
 *   surveys  14 B   int16 lat × 100, int16 lon × 100, uint32 AC, uint32 AN, uint16 radius (km)
 *
 * Areas carry exactly those fields, but are stored column by column and predictively, which
 * gzip compresses to about half (spec §7 budgets): the first vertex as a step from the previous
 * area's, the next three as edge steps, the last two as their difference from the opposite edge
 * (a hexagon's opposite edges nearly cancel), and lo and hi as distances below and above the
 * mean. Every step is an integer, so decoding is exact. Surveys are interleaved records.
 *
 * Surveys are counts only: there is no frequency field to misread (AGENTS.md, counts not
 * frequencies). An `unknown` area stores no value at all.
 */

import type { EvidenceTier } from './encoding';

export type Support =
  'observed' | 'interpolated' | 'prior_dominated' | 'unknown';

export const FIGURE_DATA_MAGIC = 'GOSF';
export const FIGURE_DATA_VERSION = 1;
export const HEADER_BYTES = 12;
export const AREA_BYTES = 34;
export const SURVEY_BYTES = 14;
export const NO_VALUE = 0xffff;
export const SUPPORT_CODES: readonly Support[] = [
  'observed',
  'interpolated',
  'prior_dominated',
  'unknown',
];
export const TIER_CODES: readonly EvidenceTier[] = [
  'none',
  'strong',
  'partial',
  'weak',
];
const KIND = { areas: 1, surveys: 2 } as const;
const VERTICES = 6;

/** A display area: an H3 parent cell coarsened from the res-4 artifact. */
export interface Area {
  /** Boundary as [lon, lat] pairs (a pentagon repeats its last vertex). */
  boundary: [number, number][];
  /** Spherical centroid of the boundary, degrees. */
  center: [number, number];
  /** Mean of the children's posterior means; null when support is unknown. */
  mean: number | null;
  /** Lowest child q025; null when unknown. */
  lo: number | null;
  /** Highest child q975; null when unknown. */
  hi: number | null;
  /** Median child distance to the nearest survey, km. */
  distanceKm: number;
  support: Support;
  tier: EvidenceTier;
}

/** A measured survey: AC carriers among AN alleles at a place stated to ±radius. */
export interface Survey {
  lat: number;
  lon: number;
  ac: number;
  an: number;
  radiusKm: number;
}

function header(view: DataView, kind: number, record: number, count: number) {
  for (let index = 0; index < 4; index += 1)
    view.setUint8(index, FIGURE_DATA_MAGIC.charCodeAt(index));
  view.setUint8(4, FIGURE_DATA_VERSION);
  view.setUint8(5, kind);
  view.setUint16(6, record, true);
  view.setUint32(8, count, true);
}

function readHeader(view: DataView, kind: number, record: number): number {
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== FIGURE_DATA_MAGIC) throw new Error(`not figure data: ${magic}`);
  if (view.getUint8(4) !== FIGURE_DATA_VERSION)
    throw new Error(`figure data version ${view.getUint8(4)}`);
  if (view.getUint8(5) !== kind || view.getUint16(6, true) !== record)
    throw new Error('figure data of the wrong kind');
  const count = view.getUint32(8, true);
  if (view.byteLength !== HEADER_BYTES + count * record)
    throw new Error('figure data is truncated');
  return count;
}

const asView = (bytes: ArrayBuffer | Uint8Array) =>
  bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);

const centi = (degrees: number) => {
  const value = Math.round(degrees * 100);
  if (value < -32768 || value > 32767)
    throw new Error(`coordinate out of range: ${degrees}`);
  return value;
};

/** ×10⁴ with the given rounding; never collides with NO_VALUE. */
function share(value: number | null, round: (x: number) => number): number {
  if (value === null) return NO_VALUE;
  if (!(value >= 0 && value <= 1))
    throw new Error(`share out of range: ${value}`);
  return Math.min(NO_VALUE - 1, round(value * 1e4));
}

/** Longitude steps wrap across the antimeridian: centi-degrees into [−18000, 18000). */
const wrapCenti = (value: number) =>
  ((((value + 18000) % 36000) + 36000) % 36000) - 18000;

/** Area columns, in file order: 12 int16 geometry columns, then 4 uint16 value columns. */
const GEOMETRY_COLUMNS = 12;
const VALUE_COLUMNS = 4;

/**
 * Encode display areas. Rounding keeps every interval honest after quantisation: the low end
 * rounds down, the high end up, the mean to nearest, so lo ≤ mean ≤ hi still holds.
 */
export function encodeAreas(
  areas: readonly Omit<Area, 'center'>[],
): Uint8Array {
  const count = areas.length;
  const bytes = new Uint8Array(HEADER_BYTES + count * AREA_BYTES);
  const view = asView(bytes);
  header(view, KIND.areas, AREA_BYTES, count);
  const geometry = Array.from(
    { length: GEOMETRY_COLUMNS },
    () => new Int16Array(count),
  );
  const values = Array.from(
    { length: VALUE_COLUMNS },
    () => new Uint16Array(count),
  );
  let previous: [number, number] = [0, 0];
  areas.forEach((area, index) => {
    if (area.boundary.length < 5 || area.boundary.length > VERTICES)
      throw new Error(
        `an area needs 5 or 6 vertices, got ${area.boundary.length}`,
      );
    const ring = area.boundary.map(([lon, lat]) => [centi(lon), centi(lat)]);
    while (ring.length < VERTICES) ring.push(ring[ring.length - 1]);
    const edge = (k: number) => [
      wrapCenti(ring[k][0] - ring[k - 1][0]),
      ring[k][1] - ring[k - 1][1],
    ];
    const [e1, e2, e3, e4, e5] = [1, 2, 3, 4, 5].map(edge);
    const steps = [
      wrapCenti(ring[0][0] - previous[0]),
      ring[0][1] - previous[1],
      ...e1,
      ...e2,
      ...e3,
      e4[0] + e1[0],
      e4[1] + e1[1],
      e5[0] + e2[0],
      e5[1] + e2[1],
    ];
    steps.forEach((step, column) => {
      if (step < -32768 || step > 32767)
        throw new Error(`area ${index}: step overflows`);
      geometry[column][index] = step;
    });
    previous = [ring[0][0], ring[0][1]];
    const unknown = area.support === 'unknown';
    const mean = share(unknown ? null : area.mean, Math.round);
    const lo = share(unknown ? null : area.lo, Math.floor);
    const hi = share(unknown ? null : area.hi, Math.ceil);
    values[0][index] = mean;
    values[1][index] = mean === NO_VALUE ? NO_VALUE : mean - lo;
    values[2][index] = mean === NO_VALUE ? NO_VALUE : hi - mean;
    values[3][index] = Math.min(0xffff, Math.round(area.distanceKm));
    if (mean !== NO_VALUE && (lo > mean || hi < mean))
      throw new Error(`area ${index}: lo ≤ mean ≤ hi fails`);
  });
  let offset = HEADER_BYTES;
  for (const column of geometry)
    for (const value of column) {
      view.setInt16(offset, value, true);
      offset += 2;
    }
  for (const column of values)
    for (const value of column) {
      view.setUint16(offset, value, true);
      offset += 2;
    }
  areas.forEach((area) =>
    view.setUint8(offset++, SUPPORT_CODES.indexOf(area.support)),
  );
  areas.forEach((area) =>
    view.setUint8(offset++, TIER_CODES.indexOf(area.tier)),
  );
  return bytes;
}

function centroid(boundary: [number, number][]): [number, number] {
  const ring =
    boundary.length === VERTICES &&
    boundary[5][0] === boundary[4][0] &&
    boundary[5][1] === boundary[4][1]
      ? boundary.slice(0, 5)
      : boundary;
  let [x, y, z] = [0, 0, 0];
  for (const [lon, lat] of ring) {
    const lambda = (lon * Math.PI) / 180;
    const phi = (lat * Math.PI) / 180;
    x += Math.cos(phi) * Math.cos(lambda);
    y += Math.cos(phi) * Math.sin(lambda);
    z += Math.sin(phi);
  }
  return [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
  ];
}

export function decodeAreas(bytes: ArrayBuffer | Uint8Array): Area[] {
  const view = asView(bytes);
  const count = readHeader(view, KIND.areas, AREA_BYTES);
  const int16 = (column: number, index: number) =>
    view.getInt16(HEADER_BYTES + (column * count + index) * 2, true);
  const uint16 = (column: number, index: number) =>
    view.getUint16(
      HEADER_BYTES + ((GEOMETRY_COLUMNS + column) * count + index) * 2,
      true,
    );
  const codes = HEADER_BYTES + (GEOMETRY_COLUMNS + VALUE_COLUMNS) * count * 2;
  let previous: [number, number] = [0, 0];
  return Array.from({ length: count }, (_, index) => {
    const step = (column: number) => int16(column, index);
    const v0: [number, number] = [
      wrapCenti(previous[0] + step(0)),
      previous[1] + step(1),
    ];
    previous = v0;
    const e1 = [step(2), step(3)];
    const e2 = [step(4), step(5)];
    const e3 = [step(6), step(7)];
    const e4 = [step(8) - e1[0], step(9) - e1[1]];
    const e5 = [step(10) - e2[0], step(11) - e2[1]];
    const ring: [number, number][] = [v0];
    for (const [dx, dy] of [e1, e2, e3, e4, e5]) {
      const [x, y] = ring[ring.length - 1];
      ring.push([wrapCenti(x + dx), y + dy]);
    }
    const boundary = ring.map(([x, y]): [number, number] => [x / 100, y / 100]);
    const meanRaw = uint16(0, index);
    const below = uint16(1, index);
    const above = uint16(2, index);
    const support = SUPPORT_CODES[view.getUint8(codes + index)];
    const tier = TIER_CODES[view.getUint8(codes + count + index)];
    if (!support || !tier) throw new Error(`bad codes in area ${index}`);
    const known = meanRaw !== NO_VALUE;
    return {
      boundary,
      center: centroid(boundary),
      mean: known ? meanRaw / 1e4 : null,
      lo: known ? (meanRaw - below) / 1e4 : null,
      hi: known ? (meanRaw + above) / 1e4 : null,
      distanceKm: uint16(3, index),
      support,
      tier,
    };
  });
}

export function encodeSurveys(surveys: readonly Survey[]): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + surveys.length * SURVEY_BYTES);
  const view = asView(bytes);
  header(view, KIND.surveys, SURVEY_BYTES, surveys.length);
  surveys.forEach(({ lat, lon, ac, an, radiusKm }, index) => {
    if (!Number.isInteger(ac) || !Number.isInteger(an) || ac < 0 || ac > an)
      throw new Error(`survey ${index} needs integer 0 ≤ ac ≤ an`);
    if (an > 0xffffffff) throw new Error(`survey ${index}: AN too large`);
    if (!Number.isInteger(radiusKm) || radiusKm < 0 || radiusKm > 0xffff)
      throw new Error(`survey ${index}: radius must be whole km`);
    const offset = HEADER_BYTES + index * SURVEY_BYTES;
    view.setInt16(offset, centi(lat), true);
    view.setInt16(offset + 2, centi(lon), true);
    view.setUint32(offset + 4, ac, true);
    view.setUint32(offset + 8, an, true);
    view.setUint16(offset + 12, radiusKm, true);
  });
  return bytes;
}

export function decodeSurveys(bytes: ArrayBuffer | Uint8Array): Survey[] {
  const view = asView(bytes);
  const count = readHeader(view, KIND.surveys, SURVEY_BYTES);
  return Array.from({ length: count }, (_, index) => {
    const offset = HEADER_BYTES + index * SURVEY_BYTES;
    return {
      lat: view.getInt16(offset, true) / 100,
      lon: view.getInt16(offset + 2, true) / 100,
      ac: view.getUint32(offset + 4, true),
      an: view.getUint32(offset + 8, true),
      radiusKm: view.getUint16(offset + 12, true),
    };
  });
}

/** Fetch and decode one committed binary (its URL comes from an `?url` import). */
export async function loadAreas(url: string): Promise<Area[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return decodeAreas(await response.arrayBuffer());
}

export async function loadSurveys(url: string): Promise<Survey[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return decodeSurveys(await response.arrayBuffer());
}
