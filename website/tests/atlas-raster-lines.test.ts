import { cellToBoundary, latLngToCell, polygonToCells } from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  brighterEdgeBytes,
  type EdgeColorSpec,
} from '../src/atlas/geometry/edge-buffers';
import { h3PolygonParts } from '../src/atlas/geometry/polygon-parts';
import {
  outlineWidthTexels,
  rasterOutlineTile,
  strokePolyline,
} from '../src/atlas/geometry/raster/line-raster';
import {
  texelCentre,
  tileRectangle,
  toTexel,
} from '../src/atlas/geometry/raster/tiling';
import type {
  SurfaceRasterInput,
  TileAddress,
  TileRaster,
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
