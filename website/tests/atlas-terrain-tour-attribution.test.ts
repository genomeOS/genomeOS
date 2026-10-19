/**
 * Unit tests for the World Terrain tour's attribution of its long frames, ground passes, draped
 * readiness and draped tiles to its steps (terrain draping design, "Performance budget and
 * measurement", #483).
 */
import { describe, expect, it } from 'vitest';

import {
  attributeTour,
  milestoneSteps,
  type TourLongFrame,
  type TourTiles,
} from './support/terrain-tour-attribution';

/** No tile yet: 7 raster bins, 12 levels of 11 delivery bins. */
function tiles(
  coarse: number[] = [0, 0, 0, 0, 0, 0, 0],
  delivered: Record<number, number[]> = {},
): TourTiles {
  return {
    coarseRasterCounts: coarse,
    deliveryByLevel: Array.from(
      { length: 12 },
      (_, level) => delivered[level] ?? Array.from({ length: 11 }, () => 0),
    ),
  };
}

function frame(startTime: number, duration: number): TourLongFrame {
  return {
    blockingDuration: Math.max(0, duration - 50),
    duration,
    scripts: [
      {
        duration: duration - 1,
        forcedStyleAndLayoutDuration: 0,
        invoker: 'FrameRequestCallback',
        invokerType: 'user-callback',
        sourceCharPosition: 120,
        sourceFunctionName: 'render',
        sourceURL: 'http://127.0.0.1:4322/_astro/atlas-scene.js',
        startTime: startTime + 1,
      },
    ],
    startTime,
  };
}

const STEPS = [
  { startMs: 1_000, step: 'World Terrain', tiles: null },
  { startMs: 5_000, step: 'orbit', tiles: tiles([1, 0, 0, 0, 0, 0, 2]) },
  { startMs: 9_000, step: 'relief 3', tiles: tiles([1, 0, 0, 0, 0, 0, 2]) },
];

describe('the terrain tour’s attribution (#483)', () => {
  it('puts each long frame in the step it started in, with the ground-pass time inside it', () => {
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles([1, 0, 0, 0, 0, 0, 2]),
      groundPasses: [
        // Inside the relief frame: all 300 ms of it.
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 300,
          startTime: 9_510,
        },
        // Half inside the switch's frame.
        {
          detail: { kind: 'create', points: 1_071 },
          duration: 80,
          startTime: 1_040,
        },
      ],
      longFrames: [frame(1_000, 80), frame(9_500, 346), frame(4_990, 60)],
      readiness: [],
      steps: STEPS,
    });
    expect(steps.map((s) => s.step)).toEqual([
      'World Terrain',
      'orbit',
      'relief 3',
    ]);
    expect(
      steps.map((s) =>
        s.longFrames.map((f) => [f.startMs, f.ms, f.groundPassMs]),
      ),
    ).toEqual([
      [
        [1_000, 80, 40],
        [4_990, 60, 0],
      ],
      [],
      [[9_500, 346, 300]],
    ]);
    expect(steps[2].longFrames[0].scripts[0].sourceFunctionName).toBe('render');
    expect(steps.map((s) => [s.startMs, s.ms])).toEqual([
      [1_000, 4_000],
      [5_000, 4_000],
      [9_000, 3_000],
    ]);
  });

  // The page reads a step's start in a task of its own, which can open the frame whose callback
  // then runs long: that frame is the new step's.
  it('puts a long frame that straddles a step’s start in the step its longest script began in', () => {
    const straddling = frame(4_999, 1_034);
    straddling.scripts = [
      { ...straddling.scripts[0], duration: 6, startTime: 4_999.5 },
      { ...straddling.scripts[0], duration: 1_023, startTime: 5_001 },
    ];
    const scriptless = { ...frame(8_999, 120), scripts: [] };
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [],
      longFrames: [straddling, scriptless],
      readiness: [],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    });
    expect(steps.map((s) => s.longFrames.map((f) => f.startMs))).toEqual([
      [],
      [4_999, 8_999],
      [],
    ]);
  });

  it('sums each step’s ground passes: their count, points picked, total and longest ms', () => {
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [
        {
          detail: { kind: 'create', points: 1_071 },
          duration: 77,
          startTime: 1_010,
        },
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 304,
          startTime: 1_200,
        },
        {
          detail: { kind: 'final', points: 1_071 },
          duration: 9,
          startTime: 4_000,
        },
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 345,
          startTime: 9_100,
        },
      ],
      longFrames: [],
      readiness: [],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    });
    expect(
      steps.map(({ groundPasses: { passes: _, ...sums } }) => sums),
    ).toEqual([
      {
        byKind: {
          create: { count: 1, picked: 1_071, totalMs: 77 },
          resample: { count: 1, picked: 1_071, totalMs: 304 },
          final: { count: 1, picked: 1_071, totalMs: 9 },
        },
        count: 3,
        maxMs: 304,
        picked: 3_213,
        totalMs: 390,
      },
      { byKind: {}, count: 0, maxMs: 0, picked: 0, totalMs: 0 },
      {
        byKind: { resample: { count: 1, picked: 1_071, totalMs: 345 } },
        count: 1,
        maxMs: 345,
        picked: 1_071,
        totalMs: 345,
      },
    ]);
    // The kinds in a fixed order, whatever the passes' order.
    expect(Object.keys(steps[0].groundPasses.byKind)).toEqual([
      'create',
      'resample',
      'final',
    ]);
  });

  it('keeps every ground pass of a step, in order: its start, ms, kind and points', () => {
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [
        {
          detail: { kind: 'highlight', points: 96 },
          duration: 21.04,
          startTime: 9_400.06,
        },
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 345.12,
          startTime: 9_100,
        },
      ],
      longFrames: [],
      readiness: [],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    });
    expect(steps.map((s) => s.groundPasses.passes)).toEqual([
      [],
      [],
      [
        { kind: 'resample', ms: 345.1, points: 1_071, startMs: 9_100 },
        { kind: 'highlight', ms: 21, points: 96, startMs: 9_400.1 },
      ],
    ]);
  });

  // The tour bounds a step at the World Terrain click and another at data visible, both on the
  // page's clock, so the step between them holds what ran from one to the other.
  it('sums the ground passes between the click and data visible, by kind, in the step those marks bound', () => {
    const steps = attributeTour({
      endMs: 20_000,
      endTiles: null,
      groundPasses: [
        // While the chooser opened, on the smooth globe: before the click.
        {
          detail: { kind: 'highlight', points: 96 },
          duration: 5,
          startTime: 1_500,
        },
        // The creation sample over the smooth globe's tiles, then World Terrain's tiles meshing.
        {
          detail: { kind: 'create', points: 1_071 },
          duration: 80,
          startTime: 2_010,
        },
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 210,
          startTime: 2_400,
        },
        {
          detail: { kind: 'highlight', points: 96 },
          duration: 20,
          startTime: 2_700,
        },
        {
          detail: { kind: 'resample', points: 1_071 },
          duration: 150,
          startTime: 3_000,
        },
        // After data visible.
        {
          detail: { kind: 'final', points: 1_071 },
          duration: 9,
          startTime: 5_800,
        },
      ],
      longFrames: [],
      readiness: [
        {
          detail: {
            branch: 'cap',
            capElapsed: true,
            frames: 40,
            layer: 'atlas-surface',
            renderedLevel: 1,
            settled: false,
          },
          duration: 3_000,
          startTime: 2_200,
        },
      ],
      steps: [
        { startMs: 1_000, step: 'World Terrain', tiles: null },
        {
          startMs: 2_000,
          step: 'World Terrain: click → data visible',
          tiles: null,
        },
        {
          startMs: 5_791,
          step: 'World Terrain: data visible → settled',
          tiles: null,
        },
      ],
    });
    const [opening, toVisible, afterVisible] = steps;
    expect(toVisible.ms).toBe(3_791);
    expect(toVisible.groundPasses).toMatchObject({
      byKind: {
        create: { count: 1, picked: 1_071, totalMs: 80 },
        resample: { count: 2, picked: 2_142, totalMs: 360 },
        highlight: { count: 1, picked: 96, totalMs: 20 },
      },
      count: 4,
      maxMs: 210,
      picked: 3_309,
      totalMs: 460,
    });
    // The surface added 200 ms after the click, read ready by the cap 3 s later, and data
    // visible 591 ms after that.
    expect(toVisible.readiness).toEqual([
      {
        branch: 'cap',
        capElapsed: true,
        frames: 40,
        layer: 'atlas-surface',
        ms: 3_000,
        renderedLevel: 1,
        settled: false,
        startMs: 2_200,
      },
    ]);
    expect(opening.groundPasses.byKind).toEqual({
      highlight: { count: 1, picked: 96, totalMs: 5 },
    });
    expect(afterVisible.groundPasses.byKind).toEqual({
      final: { count: 1, picked: 1_071, totalMs: 9 },
    });
  });

  it('lists each step’s draped readiness: the layer, the rule that fired and the ms since its add', () => {
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [],
      longFrames: [],
      readiness: [
        {
          detail: {
            branch: 'cap',
            capElapsed: true,
            frames: 90,
            layer: 'atlas-outlines',
            renderedLevel: 6,
            settled: true,
          },
          duration: 3_000,
          startTime: 1_800,
        },
        {
          detail: {
            branch: 'tiles',
            capElapsed: false,
            frames: 12,
            layer: 'atlas-surface',
            renderedLevel: 6,
            settled: true,
          },
          duration: 640,
          startTime: 1_100,
        },
      ],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    });
    // Each in the step its layer was added in, in the order they were read ready.
    expect(steps[0].readiness).toEqual([
      {
        branch: 'tiles',
        capElapsed: false,
        frames: 12,
        layer: 'atlas-surface',
        ms: 640,
        renderedLevel: 6,
        settled: true,
        startMs: 1_100,
      },
      {
        branch: 'cap',
        capElapsed: true,
        frames: 90,
        layer: 'atlas-outlines',
        ms: 3_000,
        renderedLevel: 6,
        settled: true,
        startMs: 1_800,
      },
    ]);
    expect(steps[1].readiness).toEqual([]);
  });

  it('counts the draped tiles each step delivered, from the running counts at its bounds', () => {
    const level0 = [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0];
    const level0Later = [0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0];
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles([1, 0, 0, 0, 0, 0, 3], { 0: level0Later }),
      groundPasses: [],
      longFrames: [],
      readiness: [],
      steps: [
        { startMs: 1_000, step: 'World Terrain', tiles: null },
        {
          startMs: 5_000,
          step: 'orbit',
          tiles: tiles([1, 0, 0, 0, 0, 0, 2], { 0: level0 }),
        },
      ],
    });
    expect(steps[0].tiles!.coarseRasterCounts).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(steps[0].tiles!.deliveryByLevel[0]).toEqual(level0);
    expect(steps[1].tiles!.coarseRasterCounts).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(steps[1].tiles!.deliveryByLevel[0]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it('keeps what began before the first step in a step of its own, named for it', () => {
    const steps = attributeTour({
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [],
      longFrames: [frame(900, 120)],
      readiness: [],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    });
    expect(steps.map((s) => [s.step, s.longFrames.length])).toEqual([
      ['before World Terrain', 1],
      ['World Terrain', 0],
      ['orbit', 0],
      ['relief 3', 0],
    ]);
  });

  it('bounds a step at an action and another at the milestone it waits for, or names the miss', () => {
    const click = { startMs: 2_000, tiles: null };
    const visible = { startMs: 5_791, tiles: tiles([1, 0, 0, 0, 0, 0, 0]) };
    expect(
      milestoneSteps('World Terrain', 'click', 'data visible', click, visible),
    ).toEqual([
      { step: 'World Terrain: click → data visible', ...click },
      { step: 'World Terrain: data visible → settled', ...visible },
    ]);
    expect(
      milestoneSteps('palette restyle', 'change', 'tiles loaded', click, null),
    ).toEqual([
      { step: 'palette restyle: change, tiles loaded never came', ...click },
    ]);
  });

  it('refuses steps out of order, an entry after the end, a pass of no known kind, and running counts that shrink', () => {
    const base = {
      endMs: 12_000,
      endTiles: tiles(),
      groundPasses: [],
      longFrames: [],
      readiness: [],
      steps: STEPS.map((s) => ({ ...s, tiles: null })),
    };
    expect(() =>
      attributeTour({ ...base, steps: [...base.steps].reverse() }),
    ).toThrow(/steps out of order/);
    expect(() =>
      attributeTour({ ...base, longFrames: [frame(12_000, 60)] }),
    ).toThrow(/after the tour's end/);
    expect(() =>
      attributeTour({
        ...base,
        groundPasses: [
          {
            detail: { kind: 'ring' as never, points: 96 },
            duration: 20,
            startTime: 2_000,
          },
        ],
      }),
    ).toThrow(/unknown kind 'ring'/);
    expect(() =>
      attributeTour({
        ...base,
        endTiles: tiles(),
        steps: [
          {
            startMs: 1_000,
            step: 'World Terrain',
            tiles: tiles([1, 0, 0, 0, 0, 0, 0]),
          },
        ],
      }),
    ).toThrow(/counts went down/);
  });
});
