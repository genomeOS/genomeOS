import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  naturalEarthHeights,
  type NaturalEarthBuffers,
  type NaturalEarthLabel,
} from '../src/atlas/geometry/natural-earth';
import {
  BORDERS_MAX_ERROR_DEGREES,
  BORDERS_MAX_ERROR_METRES,
  decodeNaturalEarth,
} from '../src/atlas/geometry/natural-earth-codec';
import { heightForCell } from '../src/atlas/visual-encoding';
import {
  GOLDEN_DIR,
  PARITY_DIR,
  surfaceFixturesIn,
} from './helpers/atlas-geometry';
import { parseNaturalEarthGeoJson } from './helpers/natural-earth-geojson';
import {
  encodeRings,
  packBorders,
  unpackBorders,
  type BordersHeader,
} from './support/borders-builder';

const COMMITTED_BORDERS = fileURLToPath(
  new URL('../public/data/atlas/ne-50m-admin-0.borders.bin', import.meta.url),
);
const PINNED_SOURCE = fileURLToPath(
  new URL('../../reference/ne_50m_admin_0_countries.geojson', import.meta.url),
);
const EARTH_RADIUS_M = 6_371_008.8;

const square = (x: number, y: number, size = 1): number[][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

/** The cases the legacy GeoJSON parse covered, as GOBD (holes, multi-polygons, label rules). */
const COLLECTION = encodeRings([
  {
    polygons: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [3, 2],
          [3, 3],
          [2, 2],
        ],
      ],
    ],
    properties: { LABEL_X: 10, LABEL_Y: 5, MIN_LABEL: 3, NAME_LONG: ' Alpha ' },
  },
  {
    polygons: [[square(20, 0)], [square(22, 0)]],
    properties: { ADMIN: 'Beta', LABEL_X: 20, LABEL_Y: 0, NAME_LONG: ' ' },
  },
  {
    polygons: [[square(30, 0)]],
    properties: { LABEL_X: 30, LABEL_Y: 0, NAME: 'Alpha' },
  },
  { polygons: [[square(40, 0)]], properties: { NAME_LONG: 'Gamma' } },
  {
    polygons: [[square(50, 0)]],
    properties: { LABEL_X: 50, NAME_LONG: 'Delta' },
  },
]);

function decodeBytes(bytes: Uint8Array): NaturalEarthBuffers {
  return decodeNaturalEarth(bytes.slice().buffer);
}

function withHeader(change: (header: BordersHeader) => void): Uint8Array {
  const { header, points } = unpackBorders(COLLECTION);
  change(header);
  return packBorders(header, points);
}

function withBytes(change: (bytes: Uint8Array, view: DataView) => void) {
  const bytes = COLLECTION.slice();
  change(bytes, new DataView(bytes.buffer));
  return bytes;
}

const HEADER_START = 12;
const payloadStart = (bytes: Uint8Array) => {
  const length = new DataView(bytes.buffer).getUint32(8, true);
  return HEADER_START + length + ((4 - ((HEADER_START + length) % 4)) % 4);
};

/** Each malformed container and the error it must raise (fast-load spec §B.10 check order). */
const MALFORMED: [string, () => Uint8Array, string][] = [
  ['a short file', () => COLLECTION.slice(0, 11), 'shorter than its 12-byte'],
  [
    'the wrong magic',
    () => withBytes((bytes) => bytes.set([71, 79, 83, 65], 0)),
    'magic',
  ],
  [
    'format version 2',
    () => withBytes((_, view) => view.setUint16(4, 2, true)),
    'format_version 2',
  ],
  [
    'a reserved field of 1',
    () => withBytes((_, view) => view.setUint16(6, 1, true)),
    'reserved',
  ],
  [
    'a header longer than the file',
    () => withBytes((bytes, view) => view.setUint32(8, bytes.length, true)),
    'header runs past the end',
  ],
  [
    'a header that is not UTF-8',
    () => withBytes((bytes) => (bytes[HEADER_START] = 0xff)),
    'not UTF-8 JSON',
  ],
  [
    'a header that is not an object',
    () => packBorders([], []),
    'not a JSON object',
  ],
  [
    'a non-zero padding byte',
    () => {
      const { header, points } = unpackBorders(COLLECTION);
      // Trailing spaces are valid JSON; one more than a multiple of four leaves three pad bytes.
      let text = JSON.stringify(header);
      while ((HEADER_START + text.length) % 4 !== 1) text += ' ';
      const bytes = packBorders(header, points, text);
      bytes[payloadStart(bytes) - 1] = 1;
      return bytes;
    },
    'padding',
  ],
  [
    'an extra header key',
    () => withHeader((header) => Object.assign(header, { extra: 1 })),
    'header keys',
  ],
  [
    'a fractional quantization',
    () => withHeader((header) => (header.quantization = 1.5)),
    'quantization',
  ],
  [
    'a quantization too fine for u32 deltas',
    () => withHeader((header) => (header.quantization = 1_000_001)),
    'quantization',
  ],
  [
    'a source without its digest',
    () => withHeader((header) => (header.source.sha256 = 'x')),
    'source',
  ],
  [
    'a one-vertex arc',
    () => withHeader((header) => (header.arcs[0] = 1)),
    'arcs must be vertex counts',
  ],
  [
    'a feature with an extra key',
    () => withHeader((header) => Object.assign(header.features[0], { id: 1 })),
    'feature 0 must be exactly',
  ],
  [
    'a property the overlay does not read',
    () => withHeader((header) => (header.features[0].properties.POP_EST = 1)),
    'feature 0 properties must be a subset',
  ],
  [
    'a non-string name',
    () => withHeader((header) => (header.features[2].properties.NAME = 7)),
    'feature 2 property NAME has the wrong type',
  ],
  [
    'a non-numeric label point',
    () => withHeader((header) => (header.features[0].properties.LABEL_X = '1')),
    'feature 0 property LABEL_X has the wrong type',
  ],
  [
    'a feature without polygons',
    () => withHeader((header) => (header.features[3].polygons = [])),
    'feature 3 has no polygon',
  ],
  [
    'a polygon without rings',
    () => withHeader((header) => header.features[1].polygons.push([])),
    'feature 1 polygon 2 has no ring',
  ],
  [
    'a ring without arcs',
    () => withHeader((header) => header.features[0].polygons[0].push([])),
    'feature 0 polygon 0 ring 2 has no arc',
  ],
  [
    'an arc reference past the last arc',
    () => withHeader((header) => (header.features[0].polygons[0][0][0] = 99)),
    'ring 0 refers to arc 99 of',
  ],
  [
    'a boolean arc reference',
    () =>
      withHeader(
        (header) =>
          ((header.features[0].polygons[0][0] as unknown[])[0] = true),
      ),
    'ring 0 refers to arc true of',
  ],
  [
    'an arc no ring uses',
    () =>
      withHeader((header) => {
        // Ring 1 (Alpha's hole) walks arc 0 instead, so arc 1 is unused.
        header.features[0].polygons[0][1] = [0];
      }),
    'arc 1 is never referenced',
  ],
  [
    'a payload one point short',
    () => {
      const { header, points } = unpackBorders(COLLECTION);
      return packBorders(header, points.slice(0, -2));
    },
    'for 33 arc vertices',
  ],
  [
    'a longitude past 180 degrees',
    () => {
      const { header, points } = unpackBorders(COLLECTION);
      points[0] = 1_800_001;
      return packBorders(header, points);
    },
    'outside WGS84 bounds',
  ],
  [
    'arcs that do not meet',
    () =>
      withHeader((header) => {
        header.features[1].polygons[0][0] = [2, 3];
        header.features[1].polygons[1][0] = [2, 3];
      }),
    'feature 1 polygon 0 ring 0 arc 1 does not start where arc 0 ends',
  ],
  [
    'a ring that does not close',
    () => {
      const { header, points } = unpackBorders(COLLECTION);
      // Vertex 12 ends arc 2, Beta's first square: one lattice step east of where it starts.
      points[2 * 12] += 1;
      return packBorders(header, points);
    },
    'feature 1 polygon 0 ring 0 is not closed',
  ],
  [
    'a ring of three positions',
    () => {
      const { header, points } = unpackBorders(
        encodeRings([
          {
            polygons: [
              [
                [
                  [0, 0],
                  [1, 0],
                  [0, 0],
                ],
              ],
            ],
          },
        ]),
      );
      return packBorders(header, points);
    },
    'feature 0 polygon 0 ring 0 has fewer than four positions',
  ],
];

describe('Natural Earth borders decoded in the worker (fast-load §B.6.9, §B.10)', () => {
  it('draws outer rings closed on their first point and ignores holes', () => {
    const decoded = decodeBytes(COLLECTION);
    expect(Array.from(decoded.ringOffsets)).toEqual([0, 5, 11, 17, 23, 29, 35]);
    expect(Array.from(decoded.lonLat.subarray(0, 10))).toEqual([
      0, 0, 10, 0, 10, 10, 0, 0, 0, 0,
    ]);
    expect(Array.from(decoded.lonLat.subarray(10, 22))).toEqual([
      20, 0, 21, 0, 21, 1, 20, 1, 20, 0, 20, 0,
    ]);
  });

  it('labels each distinct country text once at LABEL_X/LABEL_Y', () => {
    expect(decodeBytes(COLLECTION).labels).toEqual([
      { lat: 5, lon: 10, minLabel: 3, text: 'Alpha' },
      { lat: 0, lon: 20, minLabel: 7, text: 'Beta' },
    ]);
  });

  it('walks a shared arc backwards for the second ring that uses it', () => {
    // West and East share the edge x = 1; East walks it from (1, 1) down to (1, 0).
    const header: BordersHeader = {
      arcs: [2, 2, 3, 4],
      features: [
        { polygons: [[[0, 1, 2]]], properties: { NAME: 'West' } },
        { polygons: [[[3, ~1]]], properties: { NAME: 'East' } },
      ],
      quantization: 1,
      source: unpackBorders(COLLECTION).header.source,
    };
    const points = [
      [0, 0, 1, 0],
      [1, 0, 1, 1],
      [1, 1, 0, 1, 0, 0],
      [1, 0, 2, 0, 2, 1, 1, 1],
    ].flat();
    const decoded = decodeBytes(packBorders(header, points));
    expect(Array.from(decoded.ringOffsets)).toEqual([0, 6, 12]);
    expect(Array.from(decoded.lonLat.subarray(12))).toEqual([
      1, 0, 2, 0, 2, 1, 1, 1, 1, 0, 1, 0,
    ]);
  });

  it.each(MALFORMED)(
    'refuses %s with a TypeError instead of drawing it',
    (_name, bytes, message) => {
      const decode = () => decodeBytes(bytes());
      expect(decode).toThrow(TypeError);
      expect(decode).toThrow(message);
    },
  );

  it('accepts the bytes as an ArrayBuffer or a view of one', () => {
    const view = new Uint8Array(COLLECTION.length + 8);
    view.set(COLLECTION, 8);
    expect(decodeNaturalEarth(view.subarray(8))).toEqual(
      decodeBytes(COLLECTION),
    );
  });
});

describe('the committed compact borders against the pinned GeoJSON (issue #445)', () => {
  const legacy = parseNaturalEarthGeoJson(
    JSON.parse(readFileSync(PINNED_SOURCE, 'utf8')),
  );
  const compact = decodeNaturalEarth(
    new Uint8Array(readFileSync(COMMITTED_BORDERS)).buffer,
  );

  it('draws the same rings, vertex for vertex, and the same labels', () => {
    expect(compact.ringOffsets.length - 1).toBe(1_620);
    expect(compact.lonLat.length / 2).toBe(99_432 + 1_620);
    expect(compact.ringOffsets).toEqual(legacy.ringOffsets);
    expect(compact.lonLat.length).toBe(legacy.lonLat.length);
    // 242 features, each with its own country text and a label point, positions exact.
    expect(compact.labels).toHaveLength(242);
    expect(compact.labels).toEqual(legacy.labels);
  });

  it('moves no vertex by more than the stated bound', () => {
    let maxDegrees = 0;
    let maxMetres = 0;
    const radians = Math.PI / 180;
    for (let vertex = 0; vertex < legacy.lonLat.length / 2; vertex += 1) {
      const [lon, lat] = [
        legacy.lonLat[2 * vertex],
        legacy.lonLat[2 * vertex + 1],
      ];
      const [lon2, lat2] = [
        compact.lonLat[2 * vertex],
        compact.lonLat[2 * vertex + 1],
      ];
      maxDegrees = Math.max(
        maxDegrees,
        Math.abs(lon2 - lon),
        Math.abs(lat2 - lat),
      );
      const a =
        Math.sin(((lat2 - lat) * radians) / 2) ** 2 +
        Math.cos(lat * radians) *
          Math.cos(lat2 * radians) *
          Math.sin(((lon2 - lon) * radians) / 2) ** 2;
      maxMetres = Math.max(
        maxMetres,
        2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, a))),
      );
    }
    expect(BORDERS_MAX_ERROR_DEGREES).toBe(0.00005);
    expect(BORDERS_MAX_ERROR_METRES).toBe(7.9);
    expect(maxDegrees).toBeLessThanOrEqual(BORDERS_MAX_ERROR_DEGREES + 1e-12);
    expect(maxMetres).toBeLessThanOrEqual(BORDERS_MAX_ERROR_METRES);
    expect(maxMetres).toBeGreaterThan(7.5);
  });

  it('keeps all but 8 border vertices in their H3 resolution-4 cell, so their heights are unchanged', () => {
    const moved: number[] = [];
    for (let vertex = 0; vertex < legacy.lonLat.length / 2; vertex += 1)
      if (
        latLngToCell(
          legacy.lonLat[2 * vertex + 1],
          legacy.lonLat[2 * vertex],
          4,
        ) !==
        latLngToCell(
          compact.lonLat[2 * vertex + 1],
          compact.lonLat[2 * vertex],
          4,
        )
      )
        moved.push(vertex);
    // Each lies within 7.9 m of a cell boundary; its height is the same surface sampled 7.9 m away.
    expect(moved).toHaveLength(8);

    const [fixture] = surfaceFixturesIn(PARITY_DIR);
    expect(fixture.grid.resolution).toBe(4);
    const surface = {
      domain: fixture.artifact.metric_domains.post_mean,
      grid: fixture.grid,
      support: fixture.support,
      values: fixture.post_mean,
    };
    const before = naturalEarthHeights(legacy, surface);
    const after = naturalEarthHeights(compact, surface);
    expect(after.labelHeights).toEqual(before.labelHeights);
    expect(before.borderHeights.some((height) => height > 0)).toBe(true);
    const unmoved = (heights: Float32Array) =>
      heights.filter((_, vertex) => !moved.includes(vertex));
    expect(unmoved(after.borderHeights)).toEqual(unmoved(before.borderHeights));
  });
});

describe('Natural Earth heights (fast-load §B.6.9)', () => {
  it('raises borders and labels to the tallest supported neighbour like the legacy overlay', () => {
    const [fixture] = surfaceFixturesIn(GOLDEN_DIR);
    const metric = 'post_mean';
    const domain = fixture.artifact.metric_domains[metric];
    const points: number[] = [];
    const labels: NaturalEarthLabel[] = [];
    fixture.cells.forEach((cell, index) => {
      const [lat, lon] = cellToLatLng(cell.h3_index);
      points.push(lon, lat, lon + 0.3, lat - 0.2);
      // Off the border vertices, so the labels' own lat/lon must be read.
      labels.push({
        lat: lat + 0.15,
        lon: lon - 0.25,
        minLabel: 7,
        text: `label ${index}`,
      });
    });
    const lonLat = Float64Array.from(points);
    const { borderHeights, labelHeights } = naturalEarthHeights(
      { labels, lonLat },
      {
        domain,
        grid: fixture.grid,
        support: fixture.support,
        values: fixture.post_mean,
      },
    );
    const cells = new Map(
      fixture.froundCells.map((cell) => [cell.h3_index, cell]),
    );
    const legacyHeight = (lat: number, lon: number) => {
      let height = 0;
      for (const candidate of gridDisk(
        latLngToCell(lat, lon, fixture.grid.resolution),
        1,
      )) {
        const cell = cells.get(candidate);
        if (cell)
          height = Math.max(height, heightForCell(cell, domain, 1, metric));
      }
      return Math.fround(height);
    };
    expect(borderHeights).toHaveLength(lonLat.length / 2);
    for (let vertex = 0; vertex < lonLat.length / 2; vertex += 1)
      expect(borderHeights[vertex]).toBe(
        legacyHeight(lonLat[vertex * 2 + 1], lonLat[vertex * 2]),
      );
    expect(labelHeights).toHaveLength(labels.length);
    labels.forEach(({ lat, lon }, index) =>
      expect(labelHeights[index]).toBe(legacyHeight(lat, lon)),
    );
    expect(labelHeights.some((height) => height > 0)).toBe(true);
  });
});
