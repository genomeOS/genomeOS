import {
  Cartographic,
  GeographicTilingScheme,
  Math as CesiumMath,
} from 'cesium';
import { describe, expect, it } from 'vitest';

import {
  texelCentre,
  tileRectangle,
  toTexel,
} from '../src/atlas/geometry/raster/tiling';
import {
  ATLAS_IMAGERY_LAYER_ORDER,
  OUTLINE_MIN_LEVEL,
  OUTLINE_WIDTH_TEXELS,
  RASTER_MAX_LEVEL,
  RASTER_TILE_SIZE,
  RESIDENT_TILE_BYTES,
} from '../src/atlas/geometry/raster/types';
import { texel, tileContaining } from './helpers/raster-fixtures';

describe('raster constants (#483)', () => {
  it('pins the tile size, levels, outline widths and resident bytes', () => {
    expect([RASTER_TILE_SIZE, RASTER_MAX_LEVEL, OUTLINE_MIN_LEVEL]).toEqual([
      256, 11, 3,
    ]);
    expect(OUTLINE_WIDTH_TEXELS).toEqual([1.5, 2]);
    // 256² RGBA plus a mip chain
    expect(RESIDENT_TILE_BYTES).toBe(Math.floor((256 * 256 * 4 * 4) / 3));
    expect(ATLAS_IMAGERY_LAYER_ORDER).toEqual([
      'atlas-surface',
      'atlas-outlines',
      'atlas-borders',
      'atlas-footprints',
    ]);
  });
});

describe('raster tiling (#483)', () => {
  it("matches Cesium's GeographicTilingScheme: two 180° roots, y from the north", () => {
    expect(tileRectangle({ level: 0, x: 0, y: 0 })).toEqual({
      east: 0,
      north: 90,
      south: -90,
      west: -180,
    });
    const scheme = new GeographicTilingScheme();
    for (const a of [
      { level: 3, x: 5, y: 3 },
      { level: 9, x: 1023, y: 0 },
      { level: 11, x: 2900, y: 1100 },
    ]) {
      const r = scheme.tileXYToRectangle(a.x, a.y, a.level);
      const d = tileRectangle(a);
      for (const side of ['west', 'south', 'east', 'north'] as const)
        expect(d[side]).toBeCloseTo(CesiumMath.toDegrees(r[side]), 9);
    }
  });

  it('puts row 0 at the south edge (rows are south-first)', () => {
    const a = { level: 0, x: 1, y: 0 };
    expect(texelCentre(a, 0, 0)).toEqual({
      lat: -90 + 180 / 512,
      lon: 180 / 512,
    });
    expect(texelCentre(a, 255, 255)).toEqual({
      lat: 90 - 180 / 512,
      lon: 180 - 180 / 512,
    });
    const { lat, lon } = texelCentre({ level: 8, x: 300, y: 128 }, 17, 201);
    expect(toTexel({ level: 8, x: 300, y: 128 }, lon, lat)).toEqual({
      x: expect.closeTo(17, 9),
      y: expect.closeTo(201, 9),
    });
  });

  it("maps a tile's corners to the outer edges of its corner texels", () => {
    const a = { level: 5, x: 40, y: 9 };
    const { east, north, south, west } = tileRectangle(a);
    expect(toTexel(a, west, south)).toEqual({ x: -0.5, y: -0.5 });
    expect(toTexel(a, east, north)).toEqual({
      x: expect.closeTo(255.5, 9),
      y: expect.closeTo(255.5, 9),
    });
  });

  it('finds the tile holding a point, as Cesium does, with the far edges in the last tile', () => {
    const scheme = new GeographicTilingScheme();
    for (const [lon, lat, level] of [
      [36.793, -1.836, 7],
      [-3.709, 40.419, 11],
      [-179.99, 89.99, 4],
    ]) {
      const xy = scheme.positionToTileXY(
        Cartographic.fromDegrees(lon, lat),
        level,
      )!;
      expect(tileContaining(lon, lat, level)).toEqual({
        level,
        x: xy.x,
        y: xy.y,
      });
    }
    expect(tileContaining(180, -90, 2)).toEqual({ level: 2, x: 7, y: 3 });
  });

  it('reads texel bytes at (row × 256 + column) × 4', () => {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    rgba.set([1, 2, 3, 4], (3 * 256 + 2) * 4);
    expect(texel({ rgba }, 2, 3)).toEqual([1, 2, 3, 4]);
  });
});
