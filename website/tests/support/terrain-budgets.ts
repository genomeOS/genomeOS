/**
 * The World Terrain budgets and the judge of one measured run against them (terrain draping
 * design, "Performance budget and measurement", #483). Pure: no Playwright or browser dependency.
 *
 * `atlas-terrain-performance.spec.ts` measures a tour per project and hands the numbers here; an
 * empty list is a pass. Milliseconds and fps are judged and reported as whole numbers, rounded
 * against their budget (times up, fps down) so a measure outside a budget never rounds back into
 * it and no failure reads "2000 ms > 2000 ms"; bytes are exact. A run that measured no restyle or
 * no raster sample never passes, and a measure that is not a number fails its budget rather than
 * slipping past it. The tour records a milestone that never came (data visible, or a restyle) as
 * NaN rather than leaving it out, so a non-finite one reads "not measured" on every renderer, as
 * an empty list does: the "nothing measured" checks are never skipped, only the timings.
 *
 * On a software renderer (CI's SwiftShader) the timing budgets are skipped, as
 * `atlas-performance.spec.ts` skips its own. Resident memory is a count of tiles, not a timing,
 * so it is judged on every renderer: the plan's one departure from the spec, which skips every
 * terrain budget there (Phase 4 decision 4, pending the owner's sign-off).
 */
import type { DrapeStats } from '../../src/atlas/scene/types';

export const MIB = 1_048_576;

/** `mobile` is a coarse pointer; its imagery budget is the phones' 96 MiB. */
export type TerrainProfile = 'desktop' | 'mobile';

export interface TerrainBudgets {
  /** Terrain switch → draped data visible, at most. */
  dataVisibleMs: number;
  /** Each restyle → `globe.tilesLoaded`, at most. */
  restyleMs: number;
  /** While orbiting, at least. */
  orbitFps: number;
  /** Each long animation frame, at most. */
  longFrameMs: number;
  /** The raster time per tile at level ≥ 3 that 95% of tiles stay within, at most. */
  rasterP95Ms: number;
  /** Peak resident Atlas imagery, at most. */
  residentBytes: number;
}

const DESKTOP: TerrainBudgets = {
  dataVisibleMs: 2_000,
  restyleMs: 2_000,
  orbitFps: 45,
  longFrameMs: 200,
  rasterP95Ms: 2,
  // 480 resident tiles
  residentBytes: 160 * MIB,
};

export const TERRAIN_BUDGETS: Record<TerrainProfile, TerrainBudgets> = {
  desktop: DESKTOP,
  // 288 resident tiles
  mobile: { ...DESKTOP, longFrameMs: 800, residentBytes: 96 * MIB },
};

export interface TerrainPerformanceMetrics {
  profile: TerrainProfile;
  /** `UNMASKED_RENDERER_WEBGL`. */
  renderer: string;
  /** Terrain switch → draped data visible (Task 17's measure); NaN if it never came. */
  dataVisibleMs: number;
  /**
   * Each restyle → `globe.tilesLoaded`, NaN if that never came. A software renderer, whose
   * timings are skipped, measures each only to the outgoing layer's retirement.
   */
  restyleMs: number[];
  orbitFps: number;
  /** Long-animation-frame durations from the terrain switch on. */
  longFramesMs: number[];
  rasterMs: DrapeStats['rasterMs'];
  peakResidentBytes: number;
}

/** True for SwiftShader and other software rasterisers, as `atlas-performance.spec.ts` tests it. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|software/i.test(renderer);
}

/** The first bucket bound whose running count reaches 95% of the samples; NaN with none. */
export function rasterP95UpperMs(histogram: DrapeStats['rasterMs']): number {
  const { upperMs, counts } = histogram;
  if (counts.length !== upperMs.length) {
    throw new Error(
      `raster histogram has ${counts.length} counts for ${upperMs.length} bounds`,
    );
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return Number.NaN;
  let running = 0;
  for (let i = 0; i < counts.length; i++) {
    running += counts[i];
    // Integer comparison: 95% of `total` without a floating-point product.
    if (running * 100 >= total * 95) return upperMs[i];
  }
  throw new Error(
    `raster histogram counts are not finite: ${counts.join(', ')}`,
  );
}

/** Every budget the run is outside, in a fixed order; empty is a pass. */
export function terrainBudgetFailures(
  metrics: TerrainPerformanceMetrics,
): string[] {
  const budget = TERRAIN_BUDGETS[metrics.profile];
  const timed = !isSoftwareRenderer(metrics.renderer);
  const failures: string[] = [];
  // Negated comparisons, so a NaN measure fails instead of passing.
  const atMost = (
    label: string,
    value: number,
    limit: number,
    unit: string,
  ) => {
    if (!(value <= limit))
      failures.push(`${label} ${value} ${unit} > ${limit} ${unit}`);
  };

  if (!Number.isFinite(metrics.dataVisibleMs))
    failures.push('data visible not measured');
  else if (timed) {
    atMost(
      'data visible',
      wholeUp(metrics.dataVisibleMs),
      budget.dataVisibleMs,
      'ms',
    );
  }
  if (metrics.restyleMs.length === 0) failures.push('no restyles measured');
  for (const ms of metrics.restyleMs) {
    if (!Number.isFinite(ms)) failures.push('restyle not measured');
    else if (timed) atMost('restyle', wholeUp(ms), budget.restyleMs, 'ms');
  }
  if (timed) {
    const fps = Math.floor(metrics.orbitFps);
    if (!(fps >= budget.orbitFps)) {
      failures.push(`orbit ${fps} fps < ${budget.orbitFps} fps`);
    }
    for (const ms of metrics.longFramesMs) {
      atMost('long frame', wholeUp(ms), budget.longFrameMs, 'ms');
    }
  }
  const p95 = rasterP95UpperMs(metrics.rasterMs);
  if (Number.isNaN(p95)) failures.push('no raster samples at level 3 or finer');
  else if (timed) atMost('raster p95', wholeUp(p95), budget.rasterP95Ms, 'ms');
  atMost(
    'resident Atlas imagery',
    metrics.peakResidentBytes,
    budget.residentBytes,
    'B',
  );
  return failures;
}

/** A time as whole milliseconds, never below the measure, for an at-most budget. */
function wholeUp(value: number): number {
  return Math.ceil(value);
}
