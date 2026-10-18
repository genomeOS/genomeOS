import { latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  HONMOON_FILL_ALPHA,
  HONMOON_FILL_SHADE,
  rasterSurfaceTile,
} from '../src/atlas/geometry/raster/fill-raster';
import type { SurfaceRasterSpec } from '../src/atlas/geometry/raster/types';
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
