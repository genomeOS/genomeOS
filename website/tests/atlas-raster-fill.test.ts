import { latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  HONMOON_FILL_ALPHA,
  HONMOON_FILL_SHADE,
  rasterSurfaceTile,
} from '../src/atlas/geometry/raster/fill-raster';
import {
  texelCentre,
  tileRectangle,
} from '../src/atlas/geometry/raster/tiling';
import {
  drawMesh,
  drawPolar,
  scanTarget,
  type Mesh,
  type TexelWriter,
} from '../src/atlas/geometry/raster/triangle-scan';
import {
  RASTER_TILE_SIZE,
  type SurfaceRasterSpec,
  type TileAddress,
} from '../src/atlas/geometry/raster/types';
import { isSupportedCode } from '../src/atlas/geometry/support-codes';
import {
  buildSurfaceChunk,
  paletteBins,
} from '../src/atlas/geometry/surface-buffers';
import type { Support } from '../src/atlas/contracts';
import {
  barycentricColour,
  centreTexel,
  columnCoverage,
  drawnRows,
  forEachTexel,
  insideInnerDisk,
  KENYA_CELLS,
  lonLatTriangles,
  poleCells,
  rasterInputFor,
  rowOfCellAt,
  seamCells,
  texel,
  tileContaining,
  tilesCovering,
  wholeGridChunk,
  type TestCell,
} from './helpers/raster-fixtures';

/** The Kenya disk with every third row unknown and every third prior-dominated. */
const MIXED_CELLS: TestCell[] = KENYA_CELLS.map((cell, row) => ({
  ...cell,
  support: (
    [
      'unknown',
      'observed',
      'prior_dominated',
    ] as const satisfies readonly Support[]
  )[row % 3],
}));

/** Four attributes affine in (x, y), so every interpolation of them is exact. */
function affineField(x: number, y: number): number[] {
  return [x, y, 3 * x - 2 * y + 1, 5];
}

/** The pole's azimuthal frame, in which a pole-holding row interpolates its attributes. */
function azimuthalField(lon: number, lat: number): number[] {
  const r = 90 - Math.abs(lat);
  const radians = (lon * Math.PI) / 180;
  return affineField(r * Math.cos(radians), r * Math.sin(radians));
}

/** Calls `check` with each texel `write` received: its centre, attributes and their changes. */
function recordingWriter(
  a: TileAddress,
  check: (
    centre: { lon: number; lat: number },
    v: readonly number[],
    dColumn: readonly number[],
    dRow: readonly number[],
  ) => void,
): TexelWriter {
  return (_rgba, offset, v, dColumn, dRow) => {
    const texelIndex = offset / 4;
    const centre = texelCentre(
      a,
      texelIndex % RASTER_TILE_SIZE,
      Math.floor(texelIndex / RASTER_TILE_SIZE),
    );
    check(
      centre,
      [...v.slice(0, 4)],
      [...dColumn.slice(0, 4)],
      [...dRow.slice(0, 4)],
    );
  };
}

/** The largest |actual − expected| over every channel. */
function largestGap(actual: readonly number[], expected: readonly number[]) {
  return Math.max(...actual.map((value, d) => Math.abs(value - expected[d])));
}

describe('triangle scan (terrain draping design, #483)', () => {
  it('hands the texel writer each attribute and its exact change per column and per row', () => {
    const a: TileAddress = { level: 7, x: 154, y: 65 };
    const rect = tileRectangle(a);
    const texelDegrees = (rect.east - rect.west) / RASTER_TILE_SIZE;
    const lon = [rect.west + 0.2, rect.east - 0.3, rect.west + 0.5];
    const lat = [rect.south + 0.1, rect.south + 0.4, rect.north - 0.2];
    const mesh: Mesh = {
      attrs: lon.flatMap((x, v) => affineField(x, lat[v])),
      derivatives: true,
      dims: 4,
      lat,
      lon,
      triangles: [0, 1, 2],
    };
    const perColumn = [texelDegrees, 0, 3 * texelDegrees, 0];
    const perRow = [0, texelDegrees, -2 * texelDegrees, 0];
    let texels = 0;
    let gap = 0;
    drawMesh(
      scanTarget(a),
      mesh,
      recordingWriter(a, (centre, v, dColumn, dRow) => {
        texels += 1;
        gap = Math.max(
          gap,
          largestGap(v, affineField(centre.lon, centre.lat)),
          largestGap(dColumn, perColumn),
          largestGap(dRow, perRow),
        );
      }),
    );
    expect(texels).toBeGreaterThan(10_000);
    expect(gap).toBeLessThan(1e-9);
  });

  it('hands a pole-holding row its changes across one texel when the mesh asks for them', () => {
    const a: TileAddress = { level: 7, x: 128, y: 0 };
    const ringLon = [-150, -90, -30, 30, 90, 150];
    const lon = [0, ...ringLon];
    const lat = [89.95, ...ringLon.map(() => 89.5)];
    const triangles = ringLon.flatMap((_, k) => [0, 1 + k, 1 + ((k + 1) % 6)]);
    const half = 180 / 2 ** a.level / RASTER_TILE_SIZE / 2;
    const ring = { lat: lat.slice(1), lon: ringLon };
    for (const derivatives of [true, false]) {
      const mesh: Mesh = {
        attrs: lon.flatMap((x, v) => azimuthalField(x, lat[v])),
        derivatives,
        dims: 4,
        lat,
        lon,
        triangles,
      };
      let texels = 0;
      let gap = 0;
      drawPolar(
        scanTarget(a),
        ring,
        mesh,
        true,
        recordingWriter(a, ({ lon: x, lat: y }, v, dColumn, dRow) => {
          texels += 1;
          // inside the fan's hexagon in the azimuthal frame, where no weight is clamped
          if (y > 89.6)
            gap = Math.max(gap, largestGap(v, azimuthalField(x, y)));
          const along = (p: number[], q: number[]) =>
            p.map((value, d) => value - q[d]);
          gap = Math.max(
            gap,
            largestGap(
              dColumn,
              derivatives
                ? along(
                    azimuthalField(x + half, y),
                    azimuthalField(x - half, y),
                  )
                : [0, 0, 0, 0],
            ),
            largestGap(
              dRow,
              derivatives
                ? along(
                    azimuthalField(x, y + half),
                    azimuthalField(x, y - half),
                  )
                : [0, 0, 0, 0],
            ),
          );
        }),
      );
      expect(texels).toBeGreaterThan(10_000);
      expect(gap).toBeLessThan(1e-9);
    }
  });
});

describe('surface fill raster (terrain draping design, #483)', () => {
  it("matches buildSmoothChunk's colours within 1 byte at every texel it draws", () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'triangles' });
    const triangles = lonLatTriangles(
      buildSurfaceChunk(input, wholeGridChunk(input)),
    );
    let compared = 0;
    for (const a of tilesCovering(input, 7)) {
      forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
        const expected = barycentricColour(triangles, lon, lat);
        if (rgba[3] === 0 || !expected) return;
        compared += 1;
        for (let c = 0; c < 3; c += 1)
          expect(Math.abs(rgba[c] - expected[c])).toBeLessThanOrEqual(1);
      });
    }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('colours each flat hexagon with its paletteBins colour', () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
    const bins = paletteBins(input, 'supported');
    const a = tileContaining(36.793, -1.836, 7);
    let compared = 0;
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      const r = rowOfCellAt(input, lon, lat);
      if (r === null) return;
      compared += 1;
      expect(rgba).toEqual([...bins.colors.get(bins.binOfRow[r])!, 255]);
    });
    expect(compared).toBeGreaterThan(1_000);
  });

  it('draws both honmoon geometries as the honmoon fill until contours arrive', () => {
    expect([HONMOON_FILL_SHADE, HONMOON_FILL_ALPHA]).toEqual([0.55, 0.28]);
    for (const geometry of ['honmoon', 'honmoon-fill'] as const) {
      const [r, g, b] = centreTexel(
        rasterInputFor(KENYA_CELLS, { geometry: 'triangles' }),
        36.793,
        -1.836,
      );
      expect(
        centreTexel(rasterInputFor(KENYA_CELLS, { geometry }), 36.793, -1.836),
      ).toEqual([
        Math.round(r * 0.55),
        Math.round(g * 0.55),
        Math.round(b * 0.55),
        Math.round(0.28 * 255),
      ]);
    }
  });

  it('leaves no gap along shared edges inside the disk', () => {
    const input = rasterInputFor(KENYA_CELLS, { geometry: 'hexagons' });
    const a = tileContaining(36.793, -1.836, 8);
    let inside = 0;
    forEachTexel(rasterSurfaceTile(input, a)!, a, ({ lat, lon, rgba }) => {
      // at least one texel inside the outer ring
      if (!insideInnerDisk(input, lon, lat)) return;
      inside += 1;
      expect(rgba[3]).toBe(255);
    });
    expect(inside).toBeGreaterThan(10_000);
  });

  it('draws a ±180° cell on both sides of the antimeridian, without a seam', () => {
    const input = rasterInputFor(seamCells(), { geometry: 'hexagons' });
    const east = { level: 6, x: 127, y: 32 };
    const west = { level: 6, x: 0, y: 32 };
    expect(columnCoverage(rasterSurfaceTile(input, east)!, 255)).toBe(
      columnCoverage(rasterSurfaceTile(input, west)!, 0),
    );
    expect(columnCoverage(rasterSurfaceTile(input, west)!, 0)).toBeGreaterThan(
      0,
    );
  });

  it('reaches the pole for a pole cell', () => {
    const input = rasterInputFor(poleCells(), { geometry: 'triangles' });
    const top = rasterSurfaceTile(input, { level: 3, x: 8, y: 0 })!;
    for (let column = 0; column < 256; column += 1)
      expect(texel(top, column, 255)[3]).toBe(255);
  });

  it('writes rows south-first', () => {
    const input = rasterInputFor([
      { h3: latLngToCell(-1.5, 36.8, 4), support: 'observed', value: 0.5 },
    ]);
    // west 33.75, south -11.25, east 45, north 0
    const raster = rasterSurfaceTile(input, { level: 4, x: 19, y: 8 })!;
    const rows = drawnRows(raster);
    expect(Math.min(...rows)).toBeGreaterThan(200);
    expect(Math.max(...rows)).toBeLessThan(256);
  });

  it('returns byte-identical tiles for repeated calls, and null for a tile with nothing drawn', () => {
    const input = rasterInputFor(KENYA_CELLS);
    const a = tileContaining(36.793, -1.836, 7);
    expect(rasterSurfaceTile(input, a)!.rgba).toEqual(
      rasterSurfaceTile(input, a)!.rgba,
    );
    expect(rasterSurfaceTile(input, { level: 7, x: 0, y: 0 })).toBeNull();
  });

  it('draws supported cells only with cells.supported and masked cells only with cells.masked', () => {
    const combinations: SurfaceRasterSpec['cells'][] = [
      { masked: true, supported: true },
      { masked: false, supported: true },
      { masked: true, supported: false },
      { masked: false, supported: false },
    ];
    for (const geometry of ['triangles', 'hexagons'] as const)
      for (const cells of combinations) {
        const input = rasterInputFor(MIXED_CELLS, { cells, geometry });
        const rows = MIXED_CELLS.map((_, row) => row);
        const expected = rows.filter((row) =>
          isSupportedCode(input.support[row]) ? cells.supported : cells.masked,
        );
        expect(
          rows.filter((row) => centreTexel(input, row, 8)[3] > 0),
          JSON.stringify({ cells, geometry }),
        ).toEqual(expected);
      }
    const nothing = rasterInputFor(MIXED_CELLS, {
      cells: { masked: false, supported: false },
    });
    for (const a of tilesCovering(nothing, 6))
      expect(rasterSurfaceTile(nothing, a)).toBeNull();
  });

  it('refuses Honmoon contours on a geometry that has none', () => {
    const input = { ...rasterInputFor(KENYA_CELLS), contours: true };
    expect(() =>
      rasterSurfaceTile(input, tileContaining(36.793, -1.836, 7)),
    ).toThrow('Honmoon contours need the honmoon or honmoon-fill geometry');
  });
});
