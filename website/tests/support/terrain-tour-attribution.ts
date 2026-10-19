/**
 * The World Terrain tour's attribution (terrain draping design, "Performance budget and
 * measurement", #483): which of the tour's steps each long animation frame, ground pass and draped
 * readiness fell in, how much of each long frame was spent picking the ground, each step's ground
 * passes in sum, per kind and one by one, and how many draped tiles each step delivered, per level,
 * with the worker's raster time they took. The budgets judge the tour's totals
 * (`terrain-budgets.ts`); this says where they went. Pure: no Playwright or browser dependency.
 *
 * The phone's profile throttles the page's CPU only: CDP cannot throttle a dedicated worker, which
 * the cold-load suite records and answers by scaling its worker steps (`scaleCriticalPath`). The
 * tour does the same for its milestones, reported and never judged (`workerScaled`): each
 * milestone's time plus (rate − 1) × the raster time of the tiles delivered within it. That counts
 * every worker millisecond as delaying the milestone, so it is an upper bound; the worker's bitmap
 * creation and raster preparation are not in the raster time, so it is not a full one.
 *
 * A step is any span the tour bounds on the page's clock: an action from the moment the tour
 * reaches for its control, or a milestone such as the World Terrain click to data visible, whose
 * bounds the page reads itself. So a window between two such moments is a step of its own.
 *
 * Every time is the page's `performance.now()`. An entry belongs to the step it started in: from
 * that step's start to the next one's, the last to the tour's end. A long frame starts where its
 * longest script does, or with no script where the frame does: the page reads a step's start in a
 * task of its own, which can open the frame whose callback then runs long for the new step. One
 * that started before the first step (a long frame of the smooth globe that the page's observer
 * delivered late) lands in a step of its own named for it, so nothing the budgets count goes
 * unattributed; one at or after the end, steps out of order, or running tile counts that shrink
 * are errors.
 */

import type {
  DrapedReadyDetail,
  GroundPassDetail,
} from '../../src/atlas/e2e-hooks';
import { OUTLINE_MIN_LEVEL } from '../../src/atlas/geometry/raster/types';

/** One script of a long animation frame, as `PerformanceScriptTiming` reports it. */
export interface TourScript {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  startTime: number;
  duration: number;
  forcedStyleAndLayoutDuration: number;
}

/** One long animation frame, as `PerformanceLongAnimationFrameTiming` reports it. */
export interface TourLongFrame {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: TourScript[];
}

/** One performance measure the e2e build emitted. */
export interface TourMeasure<Detail> {
  startTime: number;
  duration: number;
  detail: Detail;
}

/** The drape stats' running counts the tour reads at each step's start. */
export interface TourTiles {
  /** Raster-time bins of the level 0–2 tiles (`DrapeStats.coarseRasterMs.counts`). */
  coarseRasterCounts: number[];
  /** Request-to-delivery bins per level (`DrapeStats.deliveryMs.byLevel`). */
  deliveryByLevel: number[][];
  /** The worker's raster time summed per level (`DrapeStats.rasterMsByLevel`). */
  rasterMsByLevel: number[];
}

/** A moment on the page's clock, with the drape stats' running counts then. */
export interface TourMark {
  startMs: number;
  /** Null before the draped runtime has published its stats: no tile counted yet. */
  tiles: TourTiles | null;
}

/** A step of the tour, from its mark to the next step's. */
export interface TourStep extends TourMark {
  step: string;
}

export interface TourRecord {
  steps: TourStep[];
  endMs: number;
  endTiles: TourTiles | null;
  longFrames: TourLongFrame[];
  groundPasses: TourMeasure<GroundPassDetail>[];
  readiness: TourMeasure<DrapedReadyDetail>[];
}

export interface StepAttribution {
  step: string;
  startMs: number;
  /** The step's length, to the next step's start or the tour's end. */
  ms: number;
  longFrames: {
    startMs: number;
    ms: number;
    blockingMs: number;
    /** The ground passes' time inside this frame. */
    groundPassMs: number;
    scripts: TourScript[];
  }[];
  groundPasses: GroundPassSums & {
    maxMs: number;
    /** The same sums per kind of pass, for the kinds the step ran, in `GROUND_PASS_KINDS` order. */
    byKind: Partial<Record<GroundPassKind, GroundPassSums>>;
    /** Every pass that began in the step, in order. */
    passes: {
      startMs: number;
      ms: number;
      kind: GroundPassKind;
      points: number;
    }[];
  };
  /** The draped layers added or shown in this step, in the order they were read ready. */
  readiness: (DrapedReadyDetail & { startMs: number; ms: number })[];
  /** The draped tiles delivered in this step; null where the tour read no counts. */
  tiles: TourTiles | null;
}

type GroundPassKind = GroundPassDetail['kind'];

/** The order a step's per-kind sums are listed in. */
const GROUND_PASS_KINDS: readonly GroundPassKind[] = [
  'create',
  'resample',
  'final',
  'highlight',
];

interface GroundPassSums {
  count: number;
  /** Points picked over the passes. */
  picked: number;
  totalMs: number;
}

function sumPasses(passes: TourMeasure<GroundPassDetail>[]): GroundPassSums {
  return {
    count: passes.length,
    picked: passes.reduce((sum, pass) => sum + pass.detail.points, 0),
    totalMs: tenth(passes.reduce((sum, pass) => sum + pass.duration, 0)),
  };
}

/** A step's ground passes: in sum, per kind and one by one. */
function groundPassesOf(
  passes: TourMeasure<GroundPassDetail>[],
): StepAttribution['groundPasses'] {
  const byKind: Partial<Record<GroundPassKind, GroundPassSums>> = {};
  for (const kind of GROUND_PASS_KINDS) {
    const ofKind = passes.filter((pass) => pass.detail.kind === kind);
    if (ofKind.length > 0) byKind[kind] = sumPasses(ofKind);
  }
  const unknown = passes.find(
    (pass) => !GROUND_PASS_KINDS.includes(pass.detail.kind),
  );
  if (unknown)
    throw new Error(
      `a ground pass of an unknown kind '${String(unknown.detail.kind)}' at ${unknown.startTime} ms`,
    );
  return {
    ...sumPasses(passes),
    byKind,
    maxMs: tenth(passes.reduce((max, pass) => Math.max(max, pass.duration), 0)),
    passes: [...passes]
      .sort((a, b) => a.startTime - b.startTime)
      .map((pass) => ({
        kind: pass.detail.kind,
        ms: tenth(pass.duration),
        points: pass.detail.points,
        startMs: tenth(pass.startTime),
      })),
  };
}

/** Milliseconds to a tenth. */
function tenth(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function zeroTiles(like: TourTiles): TourTiles {
  return {
    coarseRasterCounts: like.coarseRasterCounts.map(() => 0),
    deliveryByLevel: like.deliveryByLevel.map((bins) => bins.map(() => 0)),
    rasterMsByLevel: like.rasterMsByLevel.map(() => 0),
  };
}

/** The tiles counted from `from` to `to`, two running counts of one shape. */
function tilesBetween(
  from: TourTiles | null,
  to: TourTiles | null,
  step: string,
): TourTiles | null {
  if (to === null) {
    if (from !== null)
      throw new Error(`drape stats vanished during the step '${step}'`);
    return null;
  }
  const start = from ?? zeroTiles(to);
  const difference = (a: number[], b: number[], what: string): number[] => {
    if (a.length !== b.length)
      throw new Error(
        `${what} has ${b.length} bins at the start of '${step}' and ${a.length} at its end`,
      );
    return a.map((count, i) => {
      const delivered = count - b[i];
      if (!(delivered >= 0))
        throw new Error(
          `${what} counts went down during '${step}': ${b.join(', ')} to ${a.join(', ')}`,
        );
      return delivered;
    });
  };
  if (to.deliveryByLevel.length !== start.deliveryByLevel.length)
    throw new Error(
      `delivery levels changed during '${step}': ${start.deliveryByLevel.length} to ${to.deliveryByLevel.length}`,
    );
  return {
    coarseRasterCounts: difference(
      to.coarseRasterCounts,
      start.coarseRasterCounts,
      'coarse raster',
    ),
    deliveryByLevel: to.deliveryByLevel.map((bins, level) =>
      difference(bins, start.deliveryByLevel[level], `level ${level} delivery`),
    ),
    rasterMsByLevel: difference(
      to.rasterMsByLevel,
      start.rasterMsByLevel,
      'raster time per level',
    ),
  };
}

/** The step from `action` to `milestone` within `step`, as `milestoneSteps` names it. */
export function milestoneStep(
  step: string,
  action: string,
  milestone: string,
): string {
  return `${step}: ${action} → ${milestone}`;
}

/**
 * The steps a milestone bounds: from the action that starts it (`at`, the page's clock as the tour
 * reached for the control) to the milestone, and from the milestone to the next step; with the
 * milestone never reached, only the first, named for the miss.
 */
export function milestoneSteps(
  step: string,
  action: string,
  milestone: string,
  at: TourMark,
  reached: TourMark | null,
): TourStep[] {
  return reached
    ? [
        { step: milestoneStep(step, action, milestone), ...at },
        { step: `${step}: ${milestone} → settled`, ...reached },
      ]
    : [{ step: `${step}: ${action}, ${milestone} never came`, ...at }];
}

/** The frame's longest script; undefined for a frame without one. */
export function longestScript(
  frame: Pick<TourLongFrame, 'scripts'>,
): TourScript | undefined {
  return frame.scripts.reduce<TourScript | undefined>(
    (longest, script) =>
      longest === undefined || script.duration > longest.duration
        ? script
        : longest,
    undefined,
  );
}

/** Where a long frame's time went: its longest script's start, or the frame's own. */
function frameStart(frame: TourLongFrame): number {
  return longestScript(frame)?.startTime ?? frame.startTime;
}

/** The time `a` and `b`, two spans of the page's clock, share. */
function overlapMs(
  a: { startTime: number; duration: number },
  b: { startTime: number; duration: number },
): number {
  const start = Math.max(a.startTime, b.startTime);
  const end = Math.min(a.startTime + a.duration, b.startTime + b.duration);
  return Math.max(0, end - start);
}

/** The tour's long frames, ground passes, readiness and tiles, step by step. */
export function attributeTour(record: TourRecord): StepAttribution[] {
  const { endMs, steps } = record;
  if (steps.length === 0) throw new Error('a tour without steps');
  steps.forEach((step, i) => {
    const next = steps[i + 1]?.startMs ?? endMs;
    if (!(step.startMs < next))
      throw new Error(
        `tour steps out of order: '${step.step}' at ${step.startMs} ms, then ${next} ms`,
      );
  });
  const first = steps[0];
  const starts = [
    ...record.longFrames.map(frameStart),
    ...record.groundPasses.map((pass) => pass.startTime),
    ...record.readiness.map((ready) => ready.startTime),
  ];
  for (const start of starts)
    if (!(start < endMs))
      throw new Error(
        `an entry at ${start} ms is after the tour's end at ${endMs} ms`,
      );
  // Reduced, not spread: a production-density tour emits thousands of ground passes.
  const earliest = starts.reduce(
    (min, start) => Math.min(min, start),
    Infinity,
  );
  const buckets: {
    step: string;
    startMs: number;
    /** The running counts at the bucket's start and end. */
    tiles: [TourTiles | null, TourTiles | null];
  }[] = [];
  if (earliest < first.startMs)
    buckets.push({
      startMs: earliest,
      step: `before ${first.step}`,
      tiles: [null, null],
    });
  steps.forEach((step, i) =>
    buckets.push({
      startMs: step.startMs,
      step: step.step,
      tiles: [step.tiles, steps[i + 1] ? steps[i + 1].tiles : record.endTiles],
    }),
  );
  const bucketOf = (startTime: number): number =>
    buckets.findLastIndex((bucket) => bucket.startMs <= startTime);

  return buckets.map((bucket, index) => {
    const endOf = buckets[index + 1]?.startMs ?? endMs;
    const inBucket = <T extends { startTime: number }>(
      entries: T[],
      start: (entry: T) => number = (entry) => entry.startTime,
    ): T[] => entries.filter((entry) => bucketOf(start(entry)) === index);
    const [from, to] = bucket.tiles;
    return {
      groundPasses: groundPassesOf(inBucket(record.groundPasses)),
      longFrames: inBucket(record.longFrames, frameStart)
        .sort((a, b) => a.startTime - b.startTime)
        .map((frame) => ({
          blockingMs: tenth(frame.blockingDuration),
          groundPassMs: tenth(
            record.groundPasses.reduce(
              (sum, pass) => sum + overlapMs(frame, pass),
              0,
            ),
          ),
          ms: tenth(frame.duration),
          scripts: frame.scripts,
          startMs: tenth(frame.startTime),
        })),
      ms: tenth(endOf - bucket.startMs),
      readiness: inBucket(record.readiness)
        .sort((a, b) => a.startTime + a.duration - (b.startTime + b.duration))
        .map((ready) => ({
          ...ready.detail,
          ms: tenth(ready.duration),
          startMs: tenth(ready.startTime),
        })),
      startMs: tenth(bucket.startMs),
      step: bucket.step,
      tiles: tilesBetween(from, to, bucket.step),
    };
  });
}

/** A milestone's time with the worker's raster time scaled by the CPU rate, for the report. */
export interface WorkerScaledMilestone {
  step: string;
  observedMs: number;
  /** The raster time of the tiles delivered in the milestone's step: every level, and 0–2 alone. */
  workerMs: number;
  coarseWorkerMs: number;
  rate: number;
  /** `observedMs + (rate − 1) × workerMs`; NaN where the milestone never came. */
  scaledMs: number;
}

/**
 * Each milestone, named by the step it bounds (`milestoneSteps`), with the worker's raster time in
 * that step scaled by `rate`, as a phone's slower CPU would take it. A milestone that never came,
 * or whose step read no tile counts, scales to NaN.
 */
export function workerScaled(
  steps: StepAttribution[],
  milestones: { step: string; observedMs: number }[],
  rate: number,
): WorkerScaledMilestone[] {
  return milestones.map(({ observedMs, step }) => {
    const tiles = steps.find((attributed) => attributed.step === step)?.tiles;
    const sum = (levels: number[]) =>
      levels.reduce((total, ms) => total + ms, 0);
    const workerMs = tiles ? sum(tiles.rasterMsByLevel) : Number.NaN;
    return {
      coarseWorkerMs: tiles
        ? sum(tiles.rasterMsByLevel.slice(0, OUTLINE_MIN_LEVEL))
        : Number.NaN,
      observedMs,
      rate,
      scaledMs: observedMs + (rate - 1) * workerMs,
      step,
      workerMs,
    };
  });
}
