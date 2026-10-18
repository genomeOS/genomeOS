import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cellToBoundary, latLngToCell, polygonToCells } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  brighterEdgeBytes,
  type EdgeColorSpec,
} from '../src/atlas/geometry/edge-buffers';
import type { NaturalEarthBuffers } from '../src/atlas/geometry/natural-earth';
import { decodeNaturalEarth } from '../src/atlas/geometry/natural-earth-codec';
import { h3PolygonParts } from '../src/atlas/geometry/polygon-parts';
import {
  BORDER_WIDTH_TEXELS,
  borderBounds,
  buildSegmentIndex,
  FOOTPRINT_ALPHA,
  FOOTPRINT_RING_SEGMENTS,
  FOOTPRINT_WIDTH_TEXELS,
  footprintBounds,
  footprintRing,
  outlineWidthTexels,
  rasterBorderTile,
  rasterFootprintTile,
  rasterOutlineTile,
  strokePolyline,
  validateFootprintCircles,
} from '../src/atlas/geometry/raster/line-raster';
import {
  texelCentre,
  tileRectangle,
  toTexel,
} from '../src/atlas/geometry/raster/tiling';
import {
  RASTER_TILE_SIZE,
  type SurfaceRasterInput,
  type TileAddress,
  type TileRaster,
} from '../src/atlas/geometry/raster/types';
import { paletteBins } from '../src/atlas/geometry/surface-buffers';
import { cellLanes } from '../src/atlas/geometry/topology';
import {
  KENYA_CELLS,
  rasterInputFor,
  seamCells,
  texel,
  tileContaining,
  type TestCell,
} from './helpers/raster-fixtures';
import { sortedU64 } from './helpers/mesh-input';

/** An outline rasteriser input over `cells`, matched colours by default. */
function outlineInput(
  cells: TestCell[],
  edgeColor: EdgeColorSpec = { mode: 'matched' },
): SurfaceRasterInput & { edgeColor: EdgeColorSpec } {
  return { ...rasterInputFor(cells), edgeColor };
}

/** The Kenya disk's centre cell, whose corners all lie inside the disk. */
const CENTRE_ROW = KENYA_CELLS.findIndex(
  ({ h3 }) => h3 === latLngToCell(-1.836, 36.793, 4),
);

/** The first boundary point of the row's first polygon part, [lon, lat]. */
function firstCornerOf(
  input: SurfaceRasterInput,
  row: number,
): [number, number] {
  return h3PolygonParts(cellLanes(input.grid, row))[0][0];
}

/** The RGBA bytes of the texel whose centre is nearest (lon, lat). */
function texelAtLonLat(
  raster: TileRaster,
  a: TileAddress,
  lon: number,
  lat: number,
): [number, number, number, number] {
  const { x, y } = toTexel(a, lon, lat);
  return texel(raster, Math.round(x), Math.round(y));
}

describe('draped cell outlines (#483)', () => {
  it('draws nothing below level 3, and widens from 1.5 texels at level 3 to 2 at level 11', () => {
    expect(
      rasterOutlineTile(
        outlineInput(KENYA_CELLS),
        tileContaining(36.8, -1.8, 2),
      ),
    ).toBeNull();
    expect([3, 7, 11, 14].map(outlineWidthTexels)).toEqual([1.5, 1.75, 2, 2]);
  });

  it('strokes each supported cell’s rings at α 0.92 in the matched colour, or the fixed one', () => {
    // Three rings meet at the corner, each covering its texel fully; the first row drawn keeps it.
    // That is row 4, which shares the centre row's value (4/6) and so its matched colour.
    const input = outlineInput(KENYA_CELLS, { mode: 'matched' });
    const bins = paletteBins(input, 'supported');
    const [r, a] = [
      CENTRE_ROW,
      tileContaining(...firstCornerOf(input, CENTRE_ROW), 9),
    ];
    expect(
      texelAtLonLat(
        rasterOutlineTile(input, a)!,
        a,
        ...firstCornerOf(input, r),
      ),
    ).toEqual([
      ...brighterEdgeBytes(bins.colors.get(bins.binOfRow[r])!),
      Math.round(0.92 * 255),
    ]);
    const fixed = outlineInput(KENYA_CELLS, {
      color: '#ff8000',
      mode: 'fixed',
    });
    expect(
      texelAtLonLat(
        rasterOutlineTile(fixed, a)!,
        a,
        ...firstCornerOf(input, r),
      ).slice(0, 3),
    ).toEqual([255, 128, 0]);
  });

  it('closes each ring with the segment from its last point back to its first', () => {
    // One cell alone, so no neighbour's ring strokes the closing edge.
    const input = outlineInput([KENYA_CELLS[CENTRE_ROW]], {
      color: '#ff8000',
      mode: 'fixed',
    });
    const ring = h3PolygonParts(cellLanes(input.grid, 0))[0];
    const [first, last] = [ring[0], ring.at(-1)!];
    const middle: [number, number] = [
      (first[0] + last[0]) / 2,
      (first[1] + last[1]) / 2,
    ];
    const a = tileContaining(...middle, 9);
    expect(texelAtLonLat(rasterOutlineTile(input, a)!, a, ...middle)).toEqual([
      255,
      128,
      0,
      Math.round(0.92 * 255),
    ]);
  });

  it('strokes a ring that lies outside the tile but within reach of it, as a direct stroke does', () => {
    // Level 3 reaches 1.25 texels (0.11°), beyond the grid index's 10% box pad (under 0.01° for a
    // res-6 cell), so the rasteriser must query a grown rectangle. Cells just west of the tile:
    const a = { level: 3, x: 9, y: 3 }; // lon 22.5..45, lat 0..22.5
    const { west } = tileRectangle(a);
    const strip = polygonToCells(
      [
        [10, 22.3],
        [10, west],
        [11, west],
        [11, 22.3],
      ],
      6,
    );
    const nearEdge = sortedU64(strip).filter((h3) => {
      const east = Math.max(...cellToBoundary(h3).map(([, lon]) => lon));
      return east < west && east > west - 0.12;
    });
    let outsideQuery = 0;
    for (const h3 of nearEdge) {
      const input = outlineInput([{ h3, support: 'observed', value: 0.5 }], {
        color: '#ffffff',
        mode: 'fixed',
      });
      const ring = h3PolygonParts(h3)[0];
      const direct = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
      strokePolyline(
        direct,
        a,
        [...ring, ring[0]].flat(),
        0,
        ring.length + 1,
        outlineWidthTexels(3),
        [255, 255, 255],
        0.92,
      );
      let drawn = false;
      for (let k = 3; k < direct.rgba.length && !drawn; k += 4)
        drawn = direct.rgba[k] > 0;
      const tile = rasterOutlineTile(input, a);
      if (!drawn) expect(tile, h3).toBeNull();
      else
        expect(
          tile && Buffer.from(tile.rgba).equals(Buffer.from(direct.rgba)),
          h3,
        ).toBe(true);
      if (drawn && !input.index.rowsIn(tileRectangle(a)).includes(0))
        outsideQuery += 1;
    }
    expect(outsideQuery).toBeGreaterThan(0);
  });

  it('skips masked cells', () => {
    expect(
      rasterOutlineTile(
        outlineInput(KENYA_CELLS.map((c) => ({ ...c, support: 'unknown' }))),
        tileContaining(36.8, -1.8, 9),
      ),
    ).toBeNull();
  });

  it('refuses a fixed colour other than #rrggbb', () => {
    const input = outlineInput(KENYA_CELLS, { color: 'orange', mode: 'fixed' });
    expect(() =>
      rasterOutlineTile(input, tileContaining(36.8, -1.8, 9)),
    ).toThrow(/#rrggbb/);
  });

  it('anti-aliases over one texel beyond half the width, keeping the higher alpha where lines meet', () => {
    const raster = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
    const a = { level: 8, x: 0, y: 0 };
    const along = (row: number) => {
      const { lat } = texelCentre(a, 0, row);
      return [tileRectangle(a).west, lat, tileRectangle(a).east, lat];
    };
    strokePolyline(raster, a, along(10), 0, 2, 2, [255, 255, 255], 0.92);
    expect([10, 11, 12].map((row) => texel(raster, 128, row)[3])).toEqual([
      235,
      Math.round(0.92 * 0.5 * 255),
      0,
    ]);
    strokePolyline(raster, a, along(11), 0, 2, 2, [255, 255, 255], 0.5);
    expect(texel(raster, 128, 10)[3]).toBe(235);
  });

  it('keeps the first colour where a later stroke brings the same α, so rows drawn in order decide', () => {
    const raster = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
    const a = { level: 8, x: 0, y: 0 };
    const { lat } = texelCentre(a, 0, 40);
    const line = [tileRectangle(a).west, lat, tileRectangle(a).east, lat];
    strokePolyline(raster, a, line, 0, 2, 2, [255, 255, 255], 0.92);
    strokePolyline(raster, a, line, 0, 2, 2, [255, 0, 0], 0.92);
    expect(texel(raster, 128, 40)).toEqual([255, 255, 255, 235]);
    expect(texel(raster, 128, 41)).toEqual([255, 255, 255, 117]);
  });

  it('refuses a point that is not a finite lon, lat', () => {
    const raster = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
    const a = { level: 8, x: 0, y: 0 };
    expect(() =>
      strokePolyline(raster, a, [0, 0, Number.NaN, 1], 0, 2, 2, [0, 0, 0], 1),
    ).toThrow(/finite lon, lat/);
    expect(() =>
      strokePolyline(raster, a, [0, 0, 1, 1], 0, 3, 2, [0, 0, 0], 1),
    ).toThrow(/finite lon, lat/);
  });

  it('joins a ring across ±180° without a line around the world', () => {
    const input = outlineInput(seamCells());
    expect(rasterOutlineTile(input, { level: 6, x: 64, y: 32 })).toBeNull(); // lon 0..2.8
    expect(rasterOutlineTile(input, { level: 6, x: 0, y: 32 })).not.toBeNull();
  });

  it('strokes a segment that crosses ±180° into the tiles on both sides of it', () => {
    const east = { level: 8, x: 511, y: 127 };
    const west = { level: 8, x: 0, y: 127 };
    const { lat } = texelCentre(east, 0, 100);
    const lonLat = [179.9, lat, -179.9, lat];
    const strokeOf = (a: TileAddress) => {
      const raster = { rgba: new Uint8ClampedArray(256 * 256 * 4) };
      strokePolyline(raster, a, lonLat, 0, 2, 2, [255, 255, 255], 1);
      return raster;
    };
    expect(texel(strokeOf(east), 255, 100)[3]).toBe(255);
    expect(texel(strokeOf(west), 0, 100)[3]).toBe(255);
    expect(texel(strokeOf({ level: 8, x: 256, y: 127 }), 0, 100)[3]).toBe(0);
  });
});

const EARTH_RADIUS_KM = 6_371.0088;
const KM_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM) / 180;
const SPAIN = { lat: 40.419, lon: -3.709, radiusKm: 1.7841241161527712 }; // map-surveys:1135, on the synthetic peak
const at = (column: number, row: number) =>
  (row * RASTER_TILE_SIZE + column) * 4;
const alphaAt = (t: TileRaster, c: number, r: number) => t.rgba[at(c, r) + 3];
const rgbAt = (t: TileRaster, c: number, r: number) =>
  Array.from(t.rgba.subarray(at(c, r), at(c, r) + 3));
const ring = (...lonLat: number[]): NaturalEarthBuffers => ({
  labels: [],
  lonLat: Float64Array.from(lonLat),
  ringOffsets: Uint32Array.of(0, lonLat.length / 2),
});
const NE = (() => {
  const b = readFileSync(
    fileURLToPath(
      new URL(
        '../public/data/atlas/ne-50m-admin-0.borders.bin',
        import.meta.url,
      ),
    ),
  );
  return decodeNaturalEarth(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  );
})();

/** Great-circle distance in km on the 6,371.0088 km sphere. */
function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number) {
  const [p1, p2, dp, dl] = [lat1, lat2, lat2 - lat1, lon2 - lon1].map(
    (d) => (d * Math.PI) / 180,
  );
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

describe('draped borders (P3)', () => {
  const a = { level: 3, x: 9, y: 2 };
  const { east, west } = tileRectangle(a);
  const { lat } = texelCentre(a, 0, 100);

  it('strokes a border 1.65 texels wide, opaque, in its colour, south-first', () => {
    const tile = rasterBorderTile(
      { borders: ring(west + 1, lat, east - 1, lat), color: '#ff8000' },
      a,
    )!;
    expect(BORDER_WIDTH_TEXELS).toBe(1.65);
    expect(
      [98, 99, 100, 101, 102].map((row) => alphaAt(tile, 128, row)),
    ).toEqual([0, 83, 255, 83, 0]);
    expect(rgbAt(tile, 128, 100)).toEqual([255, 128, 0]);
    expect(alphaAt(tile, 128, 155)).toBe(0); // the mirrored row: rows run south to north
  });

  it('takes the larger coverage where strokes overlap, never their sum', () => {
    const once = rasterBorderTile(
      { borders: ring(west, lat, east, lat), color: '#ffffff' },
      a,
    )!;
    const twice = rasterBorderTile(
      {
        borders: {
          labels: [],
          lonLat: Float64Array.of(west, lat, east, lat, west, lat, east, lat),
          ringOffsets: Uint32Array.of(0, 2, 4),
        },
        color: '#ffffff',
      },
      a,
    )!;
    expect(twice.rgba).toEqual(once.rgba);
  });

  it('returns null where no border reaches, and repeats byte for byte', () => {
    const borders = ring(west + 1, lat, east - 1, lat);
    expect(
      rasterBorderTile({ borders, color: '#ffffff' }, { level: 3, x: 0, y: 0 }),
    ).toBeNull();
    expect(rasterBorderTile({ borders, color: '#ffffff' }, a)!.rgba).toEqual(
      rasterBorderTile({ borders, color: '#ffffff' }, a)!.rgba,
    );
  });

  it('draws a border on the antimeridian into the tiles on both sides of it', () => {
    // Natural Earth closes Russia, Fiji and Antarctica along ±180° (56 of its vertices lie on it).
    const eastEdge = { level: 8, x: 511, y: 127 };
    const westEdge = { level: 8, x: 0, y: 127 };
    const borders = ring(
      180,
      texelCentre(eastEdge, 0, 20).lat,
      180,
      texelCentre(eastEdge, 0, 200).lat,
    );
    expect(
      alphaAt(
        rasterBorderTile({ borders, color: '#ffffff' }, eastEdge)!,
        255,
        100,
      ),
    ).toBe(210); // 0.825 × 255
    expect(
      alphaAt(
        rasterBorderTile({ borders, color: '#ffffff' }, westEdge)!,
        0,
        100,
      ),
    ).toBe(210);
    expect(
      rasterBorderTile(
        { borders, color: '#ffffff' },
        { level: 8, x: 256, y: 127 },
      ),
    ).toBeNull();
  });

  it('refuses a border that jumps the antimeridian, and colours other than #rrggbb', () => {
    expect(() =>
      rasterBorderTile(
        { borders: ring(179, 0, -179, 0), color: '#ffffff' },
        { level: 0, x: 0, y: 0 },
      ),
    ).toThrow(/antimeridian/);
    expect(() =>
      rasterBorderTile(
        { borders: ring(0, 0, 1, 0), color: 'white' },
        { level: 0, x: 1, y: 0 },
      ),
    ).toThrow(/#rrggbb/);
  });

  it('lists each segment once and ascending, folding a query that passes ±180°', () => {
    // Rings: 0–2 along and up ±180°, 3–4 east of −180°, 5–6 far away. Segment v joins v to v + 1.
    const index = buildSegmentIndex(
      Float64Array.of(
        179.5,
        0,
        180,
        0,
        180,
        1,
        -180,
        1,
        -179.5,
        2,
        10,
        10,
        12,
        10,
      ),
      Uint32Array.of(0, 3, 5, 7),
    );
    const out = [99];
    expect(
      index.segmentsIn({ east: -179, north: 3, south: -1, west: -180.25 }, out),
    ).toBe(out);
    expect(out).toEqual([0, 1, 3]);
    expect(
      index.segmentsIn({ east: 190, north: 90, south: -90, west: -190 }),
    ).toEqual([0, 1, 3, 5]);
    expect(
      index.segmentsIn({ east: 9, north: 90, south: -90, west: -170 }),
    ).toEqual([]);
  });

  it('refuses border vertices that are not WGS84 degrees, and rings of fewer than two vertices', () => {
    const tile = { level: 0, x: 1, y: 0 };
    for (const borders of [
      ring(0, 0, Number.NaN, 1),
      ring(0, 0, 181, 1),
      ring(0, 0, 1, 91),
    ])
      expect(() =>
        rasterBorderTile({ borders, color: '#ffffff' }, tile),
      ).toThrow(/finite WGS84 lon, lat/);
    const single = {
      labels: [],
      lonLat: Float64Array.of(0, 0, 1, 1, 2, 2),
      ringOffsets: Uint32Array.of(0, 2, 3),
    };
    expect(() => borderBounds(single)).toThrow(/fewer than two vertices/);
  });

  it('bounds the Natural Earth borders one degree out', () => {
    expect(borderBounds(NE)).toEqual({
      east: 180,
      north: expect.closeTo(84.5996, 4),
      south: -90,
      west: -180,
    });
  });

  it('strokes the texel of every Natural Earth vertex at level 5 (never drops a border)', () => {
    const level = 5;
    const span = 180 / 2 ** level;
    const byTile = new Map<string, number[]>();
    for (let v = 0; v < NE.lonLat.length / 2; v += 1) {
      const x = Math.min(
        2 ** (level + 1) - 1,
        Math.floor((NE.lonLat[2 * v] + 180) / span),
      );
      const y = Math.min(
        2 ** level - 1,
        Math.floor((90 - NE.lonLat[2 * v + 1]) / span),
      );
      byTile.set(`${x},${y}`, [...(byTile.get(`${x},${y}`) ?? []), v]);
    }
    const missed: number[] = [];
    for (const [key, vertices] of byTile) {
      const [x, y] = key.split(',').map(Number);
      const tile = rasterBorderTile(
        { borders: NE, color: '#ffffff' },
        { level, x, y },
      );
      const r = tileRectangle({ level, x, y });
      for (const v of vertices) {
        const column = Math.min(
          255,
          Math.floor(((NE.lonLat[2 * v] - r.west) / span) * 256),
        );
        const row = Math.min(
          255,
          Math.floor(((NE.lonLat[2 * v + 1] - r.south) / span) * 256),
        );
        if (!tile || alphaAt(tile, column, row) === 0) missed.push(v);
      }
    }
    expect(missed.slice(0, 5)).toEqual([]);
  });
});

describe('draped sampling footprints (P3)', () => {
  it('rings each footprint at its sampling radius, 48 vertices from due north', () => {
    const ringOf = footprintRing(SPAIN.lon, SPAIN.lat, SPAIN.radiusKm);
    expect(FOOTPRINT_RING_SEGMENTS).toBe(48);
    expect(ringOf).toHaveLength(96);
    expect([ringOf[0], ringOf[1]]).toEqual([
      expect.closeTo(SPAIN.lon, 9),
      expect.closeTo(SPAIN.lat + SPAIN.radiusKm / KM_PER_DEGREE, 9),
    ]);
    for (let k = 0; k < 48; k += 1)
      expect(
        haversineKm(SPAIN.lon, SPAIN.lat, ringOf[2 * k], ringOf[2 * k + 1]),
      ).toBeCloseTo(SPAIN.radiusKm, 6);
  });

  it('strokes a footprint 2 texels wide at alpha 0.9, leaving its inside clear', () => {
    const a = { level: 8, x: 256, y: 127 };
    const top = texelCentre(a, 128, 128);
    const circles = Float64Array.of(top.lon, top.lat - 20 / KM_PER_DEGREE, 20); // vertex 0 on a texel centre
    const tile = rasterFootprintTile({ circles, color: '#ff00ff' }, a)!;
    expect([FOOTPRINT_WIDTH_TEXELS, FOOTPRINT_ALPHA]).toEqual([2, 0.9]);
    expect(
      [126, 127, 128, 129, 130].map((row) => alphaAt(tile, 128, row)),
    ).toEqual([0, 115, 230, 115, 0]);
    expect(rgbAt(tile, 128, 128)).toEqual([255, 0, 255]);
    expect(alphaAt(tile, 128, 70)).toBe(0); // inside the circle
  });

  it('draws a footprint that straddles the antimeridian on both sides of it', () => {
    const circles = Float64Array.of(179.9, 10, 50);
    expect(
      rasterFootprintTile(
        { circles, color: '#ff00ff' },
        { level: 3, x: 15, y: 3 },
      ),
    ).not.toBeNull();
    expect(
      rasterFootprintTile(
        { circles, color: '#ff00ff' },
        { level: 3, x: 0, y: 3 },
      ),
    ).not.toBeNull();
    expect(
      rasterFootprintTile(
        { circles, color: '#ff00ff' },
        { level: 3, x: 8, y: 3 },
      ),
    ).toBeNull();
    expect(footprintBounds(circles)).toMatchObject({ east: 180, west: -180 });
  });

  it('draws a footprint that encloses a pole as a band across every longitude', () => {
    const circles = Float64Array.of(0, 89, 300);
    for (let x = 0; x < 8; x += 1)
      expect(
        rasterFootprintTile(
          { circles, color: '#ff00ff' },
          { level: 2, x, y: 0 },
        ),
        `x=${x}`,
      ).not.toBeNull();
    expect(
      rasterFootprintTile(
        { circles, color: '#ff00ff' },
        { level: 2, x: 0, y: 1 },
      ),
    ).toBeNull();
  });

  it('bounds footprints one degree beyond their rings, with none for no circles', () => {
    const b = footprintBounds(Float64Array.of(10, 20, KM_PER_DEGREE))!;
    expect(b).toEqual({
      east: expect.closeTo(12.0642, 3),
      north: expect.closeTo(22, 6),
      south: expect.closeTo(18, 6),
      west: expect.closeTo(7.9358, 3),
    });
    expect(footprintBounds(new Float64Array(0))).toBeNull();
  });

  it('refuses circles that are not lon, lat, radius_km triples with a positive radius', () => {
    for (const bad of [
      Float64Array.of(1, 2),
      Float64Array.of(1, 2, 0),
      Float64Array.of(1, Number.NaN, 5),
    ])
      expect(() => validateFootprintCircles(bad)).toThrow(
        /lon, lat, radius_km triples/,
      );
  });
});
