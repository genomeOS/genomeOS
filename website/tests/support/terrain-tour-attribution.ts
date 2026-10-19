/**
 * The World Terrain tour's attribution (terrain draping design, "Performance budget and
 * measurement", #483): which of the tour's steps each long animation frame, ground pass and draped
 * readiness fell in, how much of each long frame was spent picking the ground, and how many draped
 * tiles each step delivered, per level. The budgets judge the tour's totals
 * (`terrain-budgets.ts`); this says where they went. Pure: no Playwright or browser dependency.
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
}

export interface TourStep {
  step: string;
  startMs: number;
  /** Null before the draped runtime has published its stats: no tile counted yet. */
  tiles: TourTiles | null;
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
  groundPasses: {
    count: number;
    /** Points picked over all the step's passes. */
    picked: number;
    totalMs: number;
    maxMs: number;
  };
  /** The draped layers added or shown in this step, in the order they were read ready. */
  readiness: (DrapedReadyDetail & { startMs: number; ms: number })[];
  /** The draped tiles delivered in this step; null where the tour read no counts. */
  tiles: TourTiles | null;
}

/** Milliseconds to a tenth. */
function tenth(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function zeroTiles(like: TourTiles): TourTiles {
  return {
    coarseRasterCounts: like.coarseRasterCounts.map(() => 0),
    deliveryByLevel: like.deliveryByLevel.map((bins) => bins.map(() => 0)),
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
  };
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
    const passes = inBucket(record.groundPasses);
    const [from, to] = bucket.tiles;
    return {
      groundPasses: {
        count: passes.length,
        maxMs: tenth(
          passes.reduce((max, pass) => Math.max(max, pass.duration), 0),
        ),
        picked: passes.reduce((sum, pass) => sum + pass.detail.points, 0),
        totalMs: tenth(passes.reduce((sum, pass) => sum + pass.duration, 0)),
      },
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
