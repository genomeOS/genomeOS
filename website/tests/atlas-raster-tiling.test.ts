import { describe, expect, it } from 'vitest';

import {
  ATLAS_IMAGERY_LAYER_ORDER,
  OUTLINE_MIN_LEVEL,
  OUTLINE_WIDTH_TEXELS,
  RASTER_MAX_LEVEL,
  RASTER_TILE_SIZE,
  RESIDENT_TILE_BYTES,
} from '../src/atlas/geometry/raster/types';

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
