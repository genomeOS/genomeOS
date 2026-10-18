/**
 * Unit tests for the World Terrain budget evaluator (terrain draping design, "Performance budget
 * and measurement", #483).
 */
import { describe, expect, it } from 'vitest';

import { RESIDENT_TILE_BYTES } from '../src/atlas/geometry/raster/types';

import {
  MIB,
  TERRAIN_BUDGETS,
  rasterP95UpperMs,
  terrainBudgetFailures,
  type TerrainPerformanceMetrics,
} from './support/terrain-budgets';

const PASSING: TerrainPerformanceMetrics = {
  profile: 'desktop',
  renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
  dataVisibleMs: 1_400,
  restyleMs: [900, 1_300],
  orbitFps: 58,
  longFramesMs: [120, 180],
  peakResidentBytes: 150 * MIB,
  rasterMs: {
    upperMs: [0.5, 1, 2, 4, 8, 16, Infinity],
    counts: [40, 50, 6, 4, 0, 0, 0],
  },
};
const NONE = [0, 0, 0, 0, 0, 0, 0];

describe('terrain budgets (#483)', () => {
  it('passes a run inside every budget', () =>
    expect(terrainBudgetFailures(PASSING)).toEqual([]));

  it('reads the raster p95 off the histogram', () => {
    expect(rasterP95UpperMs(PASSING.rasterMs)).toBe(2);
    expect(
      rasterP95UpperMs({ ...PASSING.rasterMs, counts: [0, 90, 4, 6, 0, 0, 0] }),
    ).toBe(4);
    expect(rasterP95UpperMs({ ...PASSING.rasterMs, counts: NONE })).toBeNaN();
  });

  it('fails each budget it is outside, with the measured number', () => {
    expect(
      terrainBudgetFailures({
        ...PASSING,
        dataVisibleMs: 2_100,
        restyleMs: [900, 2_400],
        orbitFps: 40,
        longFramesMs: [250],
        rasterMs: { ...PASSING.rasterMs, counts: [0, 90, 4, 6, 0, 0, 0] },
      }),
    ).toEqual([
      'data visible 2100 ms > 2000 ms',
      'restyle 2400 ms > 2000 ms',
      'orbit 40 fps < 45 fps',
      'long frame 250 ms > 200 ms',
      'raster p95 4 ms > 2 ms',
    ]);
  });

  it('rounds each measure against its budget, so none outside it rounds back in', () => {
    expect(
      terrainBudgetFailures({
        ...PASSING,
        dataVisibleMs: 2_000.4,
        restyleMs: [2_000.2],
        orbitFps: 44.6,
        longFramesMs: [200.3],
      }),
    ).toEqual([
      'data visible 2001 ms > 2000 ms',
      'restyle 2001 ms > 2000 ms',
      'orbit 44 fps < 45 fps',
      'long frame 201 ms > 200 ms',
    ]);
    expect(
      terrainBudgetFailures({
        ...PASSING,
        dataVisibleMs: 1_999.6,
        restyleMs: [2_000],
        orbitFps: 45.9,
        longFramesMs: [200],
      }),
    ).toEqual([]);
  });

  it('never passes a run with nothing measured', () => {
    expect(
      terrainBudgetFailures({
        ...PASSING,
        restyleMs: [],
        rasterMs: { ...PASSING.rasterMs, counts: NONE },
      }),
    ).toEqual([
      'no restyles measured',
      'no raster samples at level 3 or finer',
    ]);
  });

  it('fails a measure that is not a number rather than passing it', () => {
    expect(
      terrainBudgetFailures({
        ...PASSING,
        dataVisibleMs: Number.NaN,
        orbitFps: Number.NaN,
        peakResidentBytes: Number.NaN,
      }),
    ).toEqual([
      'data visible NaN ms > 2000 ms',
      'orbit NaN fps < 45 fps',
      'resident Atlas imagery NaN B > 167772160 B',
    ]);
  });

  it('holds phones to 96 MiB and desktops to 160 MiB of resident imagery', () => {
    const mobile = {
      ...PASSING,
      profile: 'mobile' as const,
      longFramesMs: [700],
    };
    expect(
      terrainBudgetFailures({ ...mobile, peakResidentBytes: 100_663_296 }),
    ).toEqual([]);
    expect(
      terrainBudgetFailures({ ...mobile, peakResidentBytes: 100_663_297 }),
    ).toEqual(['resident Atlas imagery 100663297 B > 100663296 B']);
    expect(
      terrainBudgetFailures({ ...PASSING, peakResidentBytes: 167_772_161 }),
    ).toEqual(['resident Atlas imagery 167772161 B > 167772160 B']);
    expect(
      Math.floor(TERRAIN_BUDGETS.mobile.residentBytes / RESIDENT_TILE_BYTES),
    ).toBe(288);
    expect(
      Math.floor(TERRAIN_BUDGETS.desktop.residentBytes / RESIDENT_TILE_BYTES),
    ).toBe(480);
  });

  it('skips the timing budgets on a software renderer, never the memory budget', () => {
    expect(
      terrainBudgetFailures({
        ...PASSING,
        renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
        dataVisibleMs: 9_000,
        orbitFps: 4,
        longFramesMs: [3_000],
        peakResidentBytes: 170 * MIB,
      }),
    ).toEqual(['resident Atlas imagery 178257920 B > 167772160 B']);
  });
});
