/**
 * Test-only GOBD v1 packer for the Natural Earth borders decoder (fast-load spec §B.10).
 * Production files are written only by scripts/encode_natural_earth_borders.py; this packs small
 * fixtures (one arc per ring) and re-packs a container so a test can change exactly one field.
 */

export interface BordersHeader {
  arcs: number[];
  features: { polygons: number[][][]; properties: Record<string, unknown> }[];
  quantization: number;
  source: { revision: string; sha256: string; url: string };
}

export const TEST_SOURCE = {
  revision: 'f'.repeat(40),
  sha256: '0'.repeat(64),
  url: 'https://example.org/ne.geojson',
};

/** The container for `header` (or exactly `headerText`) and `points`, every arc vertex as
 * interleaved lattice x, y. */
export function packBorders(
  header: unknown,
  points: readonly number[],
  headerText = JSON.stringify(header),
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(headerText);
  const start = 12 + json.length + ((4 - ((12 + json.length) % 4)) % 4);
  const bytes = new Uint8Array(start + points.length * 4);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('GOBD'), 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  const n = points.length;
  for (let index = 0; index < n; index += 1) {
    const previous = index >= 2 ? points[index - 2] : 0;
    const delta = points[index] - previous;
    const zigzag = ((delta << 1) ^ (delta >> 31)) >>> 0;
    for (let plane = 0; plane < 4; plane += 1)
      bytes[start + plane * n + index] = (zigzag >>> (8 * plane)) & 0xff;
  }
  return bytes;
}

/** A container's header and lattice points, for re-packing with one field changed. */
export function unpackBorders(bytes: Uint8Array): {
  header: BordersHeader;
  points: number[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + length)),
  ) as BordersHeader;
  const start = 12 + length + ((4 - ((12 + length) % 4)) % 4);
  const n = (bytes.length - start) / 4;
  const points: number[] = [];
  for (let index = 0; index < n; index += 1) {
    let zigzag = 0;
    for (let plane = 0; plane < 4; plane += 1)
      zigzag |= bytes[start + plane * n + index] << (8 * plane);
    zigzag >>>= 0;
    const delta = (zigzag >>> 1) ^ -(zigzag & 1);
    points.push((index >= 2 ? points[index - 2] : 0) + delta);
  }
  return { header, points };
}

export interface RingFeature {
  /** Polygons of closed rings of [lon, lat] degrees on the lattice (outer ring first). */
  polygons: number[][][][];
  properties?: Record<string, unknown>;
}

/** One arc per ring, so every ring is a single forward reference. */
export function encodeRings(
  features: readonly RingFeature[],
  quantization = 10_000,
): Uint8Array<ArrayBuffer> {
  const arcs: number[] = [];
  const points: number[] = [];
  const header: BordersHeader = {
    arcs,
    features: features.map(({ polygons, properties = {} }) => ({
      polygons: polygons.map((rings) =>
        rings.map((ring) => {
          for (const [lon, lat] of ring)
            points.push(
              Math.round(lon * quantization),
              Math.round(lat * quantization),
            );
          arcs.push(ring.length);
          return [arcs.length - 1];
        }),
      ),
      properties,
    })),
    quantization,
    source: TEST_SOURCE,
  };
  return packBorders(header, points);
}
