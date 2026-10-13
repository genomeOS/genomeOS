/** Decoder for the compact Natural Earth borders, run in the Atlas data worker (fast-load spec
 * 2026-10-07 §B.6.9, §B.10; issue #445).
 *
 * `scripts/encode_natural_earth_borders.py` writes GOBD v1 from the pinned 1:50m admin-0
 * GeoJSON: each position rounded half-to-even onto a 10⁻⁴-degree lattice, each shared border
 * stored once as an arc, arc vertices as byte-shuffled zigzag u32 lattice deltas, and only the six
 * properties the overlay reads. Little-endian:
 *
 *   offset 0  : magic "GOBD"; u16 format_version = 1; u16 reserved = 0; u32 header_length
 *   offset 12 : header JSON {arcs, features, quantization, source}, then 0x00 padding to align 4
 *             : payload, 2·V u32 for V = sum(arcs): byte k of element i at k·2V + i
 *
 * **Error bound.** A decoded coordinate is `lattice / quantization`, the source coordinate
 * rounded to the lattice: within `BORDERS_MAX_ERROR_DEGREES` (0.00005°) of the source per axis,
 * and so within `BORDERS_MAX_ERROR_METRES` (7.9 m) on the ground; the committed file's worst
 * position is 7.82 m off. Rings, vertex counts and order, and labels are exact, so the buffers
 * have the shape the GeoJSON parse gave (tests/helpers/natural-earth-geojson.ts, the reference
 * the tests hold this decoder to).
 *
 * **Heights.** `naturalEarthHeights` is unchanged and runs on the decoded positions, so a border
 * vertex's height is the same rule applied at most 7.9 m from where it was applied before. 8 of
 * the 101,052 drawn vertices lie that close to an H3 resolution-4 cell edge and now take the
 * neighbouring cell's disk: over the 30 published layers and both metrics, 269 of their 480
 * heights differ, by at most 2,786 m at exaggeration 1. Every other border height and every
 * label height is bit-identical; the tests pin the 8.
 *
 * As before, one ring is drawn per polygon outer boundary (holes are decoded and checked, not
 * drawn), closed by repeating its first coordinate, and one label per distinct country text.
 * Every violation of the format is a hard error (AGENTS; spec v1 §12): a `TypeError` that names
 * the check, raised in the same order as the Python decoder, never a silent skip.
 */

import {
  labelFor,
  type CountryProperties,
  type NaturalEarthBuffers,
  type NaturalEarthLabel,
} from './natural-earth';

/** Half a 10⁻⁴-degree lattice step: the most any coordinate moves, per axis. */
export const BORDERS_MAX_ERROR_DEGREES = 0.00005;
/** The ground distance that bound allows anywhere (7.86 m at the equator), rounded up. */
export const BORDERS_MAX_ERROR_METRES = 7.9;

const MAGIC = [0x47, 0x4f, 0x42, 0x44]; // "GOBD"
const FORMAT_VERSION = 1;
const PREAMBLE_BYTES = 12;
/** Largest lattice whose deltas (up to 360° across) still zigzag into a u32. */
const MAX_QUANTIZATION = 1_000_000;
const HEADER_KEYS = ['arcs', 'features', 'quantization', 'source'];
const TEXT_PROPERTIES = new Set(['ADMIN', 'NAME', 'NAME_LONG']);
const NUMBER_PROPERTIES = new Set(['LABEL_X', 'LABEL_Y', 'MIN_LABEL']);
const SHA256 = /^[0-9a-f]{64}$/;

interface Header {
  arcs: number[];
  features: { polygons: number[][][]; properties: CountryProperties }[];
  quantization: number;
}

const fail = (message: string): never => {
  throw new TypeError(message);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

const isCount = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;

/** An arc index, or `~index` for the arc walked backwards. */
const isArcRef = (value: unknown, arcCount: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= -arcCount &&
  (value as number) < arcCount;

function validateProperties(value: unknown, where: string): CountryProperties {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(
      (key) => TEXT_PROPERTIES.has(key) || NUMBER_PROPERTIES.has(key),
    )
  )
    fail(
      `${where} properties must be a subset of ${JSON.stringify([...TEXT_PROPERTIES, ...NUMBER_PROPERTIES].sort())}`,
    );
  for (const [key, property] of Object.entries(value as object))
    if (
      TEXT_PROPERTIES.has(key)
        ? typeof property !== 'string'
        : typeof property !== 'number' || !Number.isFinite(property)
    )
      fail(`${where} property ${key} has the wrong type`);
  return value as CountryProperties;
}

/** The strict header schema, arc references in range, and every arc used. */
function validateHeader(header: Record<string, unknown>): Header {
  if (!hasKeys(header, HEADER_KEYS))
    fail(`GOBD header keys must be exactly ${JSON.stringify(HEADER_KEYS)}`);
  const { arcs, features, quantization, source } = header;
  if (!isCount(quantization, 1) || quantization > MAX_QUANTIZATION)
    fail(`GOBD quantization must be an integer in [1, ${MAX_QUANTIZATION}]`);
  if (
    !isRecord(source) ||
    !hasKeys(source, ['revision', 'sha256', 'url']) ||
    !Object.values(source).every((part) => typeof part === 'string' && part) ||
    !SHA256.test(source.sha256 as string)
  )
    fail('GOBD source must be {revision, sha256 (64 lowercase hex), url}');
  if (!Array.isArray(arcs) || !arcs.every((count) => isCount(count, 2)))
    fail('GOBD arcs must be vertex counts of at least 2');
  if (!Array.isArray(features)) fail('GOBD features must be an array');
  const arcCount = (arcs as number[]).length;
  const used = new Uint8Array(arcCount);
  (features as unknown[]).forEach((feature, index) => {
    const where = `Natural Earth feature ${index}`;
    if (!isRecord(feature) || !hasKeys(feature, ['polygons', 'properties']))
      fail(`${where} must be exactly {polygons, properties}`);
    const { polygons, properties } = feature as Record<string, unknown>;
    validateProperties(properties, where);
    if (!Array.isArray(polygons) || polygons.length === 0)
      fail(`${where} has no polygon`);
    (polygons as unknown[]).forEach((polygon, p) => {
      if (!Array.isArray(polygon) || polygon.length === 0)
        fail(`${where} polygon ${p} has no ring`);
      (polygon as unknown[]).forEach((ring, r) => {
        if (!Array.isArray(ring) || ring.length === 0)
          fail(`${where} polygon ${p} ring ${r} has no arc`);
        for (const ref of ring as unknown[]) {
          if (!isArcRef(ref, arcCount))
            fail(
              `${where} polygon ${p} ring ${r} refers to arc ${String(ref)} of ${arcCount}`,
            );
          const arc = ref as number;
          used[arc >= 0 ? arc : ~arc] = 1;
        }
      });
    });
  });
  const unused = used.indexOf(0);
  if (unused >= 0) fail(`GOBD arc ${unused} is never referenced`);
  return header as unknown as Header;
}

/** The preamble, header JSON and zero padding; returns the header and where the payload starts. */
function readContainer(bytes: Uint8Array): {
  header: Record<string, unknown>;
  payloadStart: number;
} {
  if (bytes.byteLength < PREAMBLE_BYTES)
    fail('GOBD file is shorter than its 12-byte preamble');
  if (!MAGIC.every((byte, index) => bytes[index] === byte))
    fail('GOBD magic is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION)
    fail(`GOBD format_version ${version} is not ${FORMAT_VERSION}`);
  if (view.getUint16(6, true) !== 0) fail('GOBD reserved field is not 0');
  const headerLength = view.getUint32(8, true);
  const headerEnd = PREAMBLE_BYTES + headerLength;
  const payloadStart = headerEnd + ((4 - (headerEnd % 4)) % 4);
  if (payloadStart > bytes.byteLength)
    fail('GOBD header runs past the end of the file');
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(PREAMBLE_BYTES, headerEnd),
      ),
    );
  } catch (error) {
    fail(`GOBD header is not UTF-8 JSON: ${(error as Error).message}`);
  }
  if (!isRecord(header)) fail('GOBD header is not a JSON object');
  for (let index = headerEnd; index < payloadStart; index += 1)
    if (bytes[index] !== 0) fail('GOBD padding byte is not 0');
  return { header: header as Record<string, unknown>, payloadStart };
}

/** Lattice x, y of every arc vertex, from the shuffled zigzag deltas. */
function readPoints(
  bytes: Uint8Array,
  start: number,
  vertices: number,
  quantization: number,
): Int32Array {
  const count = 2 * vertices;
  const points = new Int32Array(count);
  const [plane0, plane1, plane2, plane3] = [0, 1, 2, 3].map(
    (plane) => start + plane * count,
  );
  const lonLimit = 180 * quantization;
  let x = 0;
  let y = 0;
  for (let index = 0; index < count; index += 2) {
    const zx =
      (bytes[plane0 + index] |
        (bytes[plane1 + index] << 8) |
        (bytes[plane2 + index] << 16) |
        (bytes[plane3 + index] << 24)) >>>
      0;
    const zy =
      (bytes[plane0 + index + 1] |
        (bytes[plane1 + index + 1] << 8) |
        (bytes[plane2 + index + 1] << 16) |
        (bytes[plane3 + index + 1] << 24)) >>>
      0;
    // Unsigned halves and Number sums: a hostile delta cannot wrap past the bounds check.
    x += zx & 1 ? -((zx + 1) / 2) : zx / 2;
    y += zy & 1 ? -((zy + 1) / 2) : zy / 2;
    if (Math.abs(x) > lonLimit || Math.abs(y) > lonLimit / 2)
      fail('GOBD has a coordinate outside WGS84 bounds');
    points[index] = x;
    points[index + 1] = y;
  }
  return points;
}

/**
 * Checks that a ring's arcs meet end to start and close on its first vertex, with at least four
 * positions (RFC 7946 §3.1.6), and returns its closed length in positions.
 */
function closedRingLength(
  refs: readonly number[],
  arcStart: Uint32Array,
  points: Int32Array,
  where: string,
): number {
  const ends = (ref: number) => {
    const arc = ref >= 0 ? ref : ~ref;
    const first = arcStart[arc];
    const last = arcStart[arc + 1] - 1;
    return ref >= 0 ? [first, last] : [last, first];
  };
  const same = (a: number, b: number) =>
    points[2 * a] === points[2 * b] && points[2 * a + 1] === points[2 * b + 1];
  const [ringStart] = ends(refs[0]);
  let length = 1;
  let previousEnd = ringStart;
  refs.forEach((ref, position) => {
    const [start, end] = ends(ref);
    if (!same(previousEnd, start))
      fail(
        `${where} arc ${position} does not start where arc ${position - 1} ends`,
      );
    length += Math.abs(end - start);
    previousEnd = end;
  });
  if (!same(previousEnd, ringStart)) fail(`${where} is not closed`);
  if (length < 4) fail(`${where} has fewer than four positions`);
  return length;
}

/** The GOBD bytes as ring vertex buffers and a label table; throws on any violation. */
export function decodeNaturalEarth(
  input: ArrayBuffer | Uint8Array,
): NaturalEarthBuffers {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { header: raw, payloadStart } = readContainer(bytes);
  const header = validateHeader(raw);
  // Summed as Numbers before any typed array holds them, so huge counts fail here, not wrap.
  const vertices = header.arcs.reduce((sum, count) => sum + count, 0);
  const expected = payloadStart + 8 * vertices;
  if (bytes.byteLength !== expected)
    fail(
      `GOBD length ${bytes.byteLength} is not ${expected} for ${vertices} arc vertices`,
    );
  const arcStart = new Uint32Array(header.arcs.length + 1);
  header.arcs.forEach((count, arc) => {
    arcStart[arc + 1] = arcStart[arc] + count;
  });
  const points = readPoints(bytes, payloadStart, vertices, header.quantization);

  // Every ring is checked before any is drawn; each outer ring is drawn closed, then its first
  // vertex once more, exactly as the GeoJSON parse drew `[...outer, outer[0]]`.
  const outer: number[][] = [];
  let drawn = 0;
  header.features.forEach(({ polygons }, index) =>
    polygons.forEach((rings, p) =>
      rings.forEach((refs, r) => {
        const length = closedRingLength(
          refs,
          arcStart,
          points,
          `Natural Earth feature ${index} polygon ${p} ring ${r}`,
        );
        if (r > 0) return;
        outer.push(refs);
        drawn += length + 1;
      }),
    ),
  );
  const ringOffsets = new Uint32Array(outer.length + 1);
  const lonLat = new Float64Array(2 * drawn);
  const { quantization } = header;
  let cursor = 0;
  const put = (vertex: number) => {
    lonLat[cursor] = points[2 * vertex] / quantization;
    lonLat[cursor + 1] = points[2 * vertex + 1] / quantization;
    cursor += 2;
  };
  outer.forEach((refs, ring) => {
    const first = cursor;
    refs.forEach((ref, position) => {
      const arc = ref >= 0 ? ref : ~ref;
      const start = arcStart[arc];
      const end = arcStart[arc + 1] - 1;
      // Consecutive arcs share their joining vertex: only the first arc writes its start.
      for (let step = position === 0 ? 0 : 1; step <= end - start; step += 1)
        put(ref >= 0 ? start + step : end - step);
    });
    lonLat.copyWithin(cursor, first, first + 2);
    cursor += 2;
    ringOffsets[ring + 1] = cursor / 2;
  });

  const labels: NaturalEarthLabel[] = [];
  const labelled = new Set<string>();
  for (const { properties } of header.features) {
    const label = labelFor(properties, labelled);
    if (label) labels.push(label);
  }
  return { labels, lonLat, ringOffsets };
}
