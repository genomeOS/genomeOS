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

/**
 * Encode display areas. Rounding keeps every interval honest after quantisation: the low end
 * rounds down, the high end up, the mean to nearest, so lo ≤ mean ≤ hi still holds.
 */
export function encodeAreas(
  areas: readonly Omit<Area, 'center'>[],
): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + areas.length * AREA_BYTES);
  const view = asView(bytes);
  header(view, KIND.areas, AREA_BYTES, areas.length);
  areas.forEach((area, index) => {
    const offset = HEADER_BYTES + index * AREA_BYTES;
    if (area.boundary.length < 5 || area.boundary.length > VERTICES)
      throw new Error(
        `an area needs 5 or 6 vertices, got ${area.boundary.length}`,
      );
    const ring = [...area.boundary];
    while (ring.length < VERTICES) ring.push(ring[ring.length - 1]);
    ring.forEach(([lon, lat], vertex) => {
      view.setInt16(offset + vertex * 4, centi(lon), true);
      view.setInt16(offset + vertex * 4 + 2, centi(lat), true);
    });
    const unknown = area.support === 'unknown';
    view.setUint16(
      offset + 24,
      share(unknown ? null : area.mean, Math.round),
      true,
    );
    view.setUint16(
      offset + 26,
      share(unknown ? null : area.lo, Math.floor),
      true,
    );
    view.setUint16(
      offset + 28,
      share(unknown ? null : area.hi, Math.ceil),
      true,
    );
    view.setUint16(
      offset + 30,
      Math.min(0xffff, Math.round(area.distanceKm)),
      true,
    );
    view.setUint8(offset + 32, SUPPORT_CODES.indexOf(area.support));
    view.setUint8(offset + 33, TIER_CODES.indexOf(area.tier));
  });
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
  const value = (offset: number) => {
    const raw = view.getUint16(offset, true);
    return raw === NO_VALUE ? null : raw / 1e4;
  };
  return Array.from({ length: count }, (_, index) => {
    const offset = HEADER_BYTES + index * AREA_BYTES;
    const boundary = Array.from(
      { length: VERTICES },
      (_, vertex): [number, number] => [
        view.getInt16(offset + vertex * 4, true) / 100,
        view.getInt16(offset + vertex * 4 + 2, true) / 100,
      ],
    );
    const support = SUPPORT_CODES[view.getUint8(offset + 32)];
    const tier = TIER_CODES[view.getUint8(offset + 33)];
    if (!support || !tier) throw new Error(`bad codes in area ${index}`);
    return {
      boundary,
      center: centroid(boundary),
      mean: value(offset + 24),
      lo: value(offset + 26),
      hi: value(offset + 28),
      distanceKm: view.getUint16(offset + 30, true),
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
