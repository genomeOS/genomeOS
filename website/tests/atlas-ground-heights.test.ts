/** Ground heights under World Terrain: sampling, throttling, the triggers that re-sample them
 * (terrain draping design, "Per layer under World Terrain", "Exaggeration", "2D and Columbus" and
 * "Failure modes"; #483), and the e2e build's measure of each pass ("Performance budget and
 * measurement"). */
import { Cartographic } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GROUND_PASS_MEASURE } from '../src/atlas/e2e-hooks';

import {
  afterNextRender,
  createFramePickBudget,
  createGroundHeights,
  createReliefResampler,
  GROUND_PICK_BUDGET_MS,
  GROUND_RESAMPLE_MS,
  onTileLoads,
  throttleResample,
} from '../src/atlas/scene/ground-heights';
import { FakeEvent } from './helpers/scene-fakes';
import {
  fakeTerrain,
  type FakeTerrain,
  type GroundAt,
} from './helpers/terrain-fakes';

class ProgressEvent {
  // Cesium raises tileLoadProgressEvent with the tile queue's length
  readonly listeners = new Set<(length: number) => void>();
  addEventListener(l: (length: number) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  raiseEvent(length: number) {
    for (const l of [...this.listeners]) l(length);
  }
}
/** The Spain survey on the synthetic peak (map-surveys:1135), then the Gabon survey (map-surveys:996). */
const POINTS = Float64Array.of(-3.709, 40.419, 12.686, -1.844);

/**
 * The scene ground heights read, over a fake terrain that counts its picks
 * (tests/helpers/terrain-fakes.ts), with the camera 20,000 km over (0°, 0°). `frame()` renders
 * one frame: `preRender`, then `postRender`.
 */
function groundScene(terrain: FakeTerrain) {
  const preRender = new FakeEvent();
  const postRender = new FakeEvent();
  return {
    camera: { positionCartographic: Cartographic.fromDegrees(0, 0, 2e7) },
    frame() {
      preRender.raiseEvent();
      postRender.raiseEvent();
    },
    globe: Object.assign(terrain.globe, {
      tileLoadProgressEvent: new ProgressEvent(),
    }),
    morphComplete: new FakeEvent(),
    postRender,
    preRender,
    requestRender: vi.fn(),
  };
}

/** Each pick of `terrain` takes 1 ms on `clock`. */
function timePicks(terrain: FakeTerrain, clock: { now: number }): void {
  const pick = terrain.globe.getHeight.getMockImplementation()!;
  terrain.globe.getHeight.mockImplementation((c) => {
    clock.now += 1;
    return pick(c);
  });
}

/**
 * Ground heights over a fake terrain: `setGround` loads new terrain meshes under both points,
 * drawing `next`, as tiles loading do.
 */
function setup(initial: GroundAt) {
  const clock = { now: 0 };
  const terrain = fakeTerrain(initial);
  const scene = groundScene(terrain);
  const heights = createGroundHeights(scene as never, POINTS, () => clock.now);
  return {
    clock,
    globe: scene.globe,
    heights,
    morphComplete: scene.morphComplete,
    scene,
    terrain,
    setGround: (next: GroundAt) => terrain.load(next),
  };
}

describe('ground heights under World Terrain', () => {
  it('samples at creation and tells listeners only when a height changed', () => {
    const { heights, setGround } = setup((lon) =>
      lon < 0 ? 6_000 : undefined,
    );
    expect(Array.from(heights.heights())).toEqual([6_000, Number.NaN]);
    const heard = vi.fn();
    heights.onChange(heard);
    heights.resample(true);
    expect(heard).not.toHaveBeenCalled(); // NaN stayed NaN: no change
    setGround((lon) => (lon < 0 ? 6_500 : undefined));
    heights.resample(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(Array.from(heard.mock.calls[0][0] as Float64Array)).toEqual([
      6_500,
      Number.NaN,
    ]);
  });

  it('resamples at most every 50 ms unless the resample is final', () => {
    const { clock, heights, setGround } = setup(() => 1_000);
    expect(GROUND_RESAMPLE_MS).toBe(50);
    setGround(() => 2_000);
    clock.now = 49;
    heights.resample();
    expect(heights.heights()[0]).toBe(1_000);
    clock.now = 50;
    heights.resample();
    expect(heights.heights()[0]).toBe(2_000);
    setGround(() => 3_000);
    clock.now = 51;
    heights.resample(true);
    expect(heights.heights()[0]).toBe(3_000);
  });

  it('resamples as terrain tiles load, and once more when their queue empties', () => {
    const { clock, globe, heights, setGround } = setup(() => 1_000);
    setGround(() => 2_000);
    clock.now = 10;
    globe.tileLoadProgressEvent.raiseEvent(4);
    expect(heights.heights()[0]).toBe(1_000);
    clock.now = 60;
    globe.tileLoadProgressEvent.raiseEvent(3);
    expect(heights.heights()[0]).toBe(2_000);
    setGround(() => 3_000);
    clock.now = 70;
    globe.tileLoadProgressEvent.raiseEvent(0);
    expect(heights.heights()[0]).toBe(3_000);
  });

  it('resamples once a morph between views completes', () => {
    const { clock, heights, morphComplete, setGround } = setup(() => 1_000);
    setGround(() => 2_000);
    clock.now = 1;
    morphComplete.raiseEvent();
    expect(heights.heights()[0]).toBe(2_000);
  });

  it('follows a relief change without a pick, and picks again only under meshes that changed', () => {
    const { globe, heights, terrain } = setup(() => 1_000);
    expect(globe.getHeight).toHaveBeenCalledTimes(2);
    globe.getHeight.mockClear();
    terrain.setRelief(3); // the frame after a relief change re-exaggerates every mesh
    heights.resample(true);
    expect(globe.getHeight).not.toHaveBeenCalled();
    expect(Array.from(heights.heights())).toEqual([3_000, 3_000]);
    heights.resample(true); // a pass over unchanged tiles
    expect(globe.getHeight).not.toHaveBeenCalled();
    terrain.load(() => 1_200, 'east'); // a tile loads under the Gabon survey only
    heights.resample(true);
    expect(globe.getHeight).toHaveBeenCalledTimes(1);
    expect(Array.from(heights.heights())).toEqual([3_000, 3_600]);
  });

  it('stops listening once destroyed, and tells no unsubscribed listener', () => {
    const { globe, heights, morphComplete, scene, setGround } = setup(
      () => 1_000,
    );
    const kept = vi.fn(),
      dropped = vi.fn();
    heights.onChange(kept);
    heights.onChange(dropped)();
    setGround(() => 2_000);
    heights.resample(true);
    expect([kept.mock.calls.length, dropped.mock.calls.length]).toEqual([1, 0]);
    heights.destroy();
    expect(globe.tileLoadProgressEvent.listeners.size).toBe(0);
    expect(morphComplete.numberOfListeners).toBe(0);
    expect(scene.preRender.numberOfListeners).toBe(0);
    expect(scene.postRender.numberOfListeners).toBe(0);
    setGround(() => 3_000);
    heights.resample(true);
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('refuses coordinates that are not lon, lat pairs', () => {
    const scene = {
      globe: { getHeight: () => 0, tileLoadProgressEvent: new ProgressEvent() },
      morphComplete: new FakeEvent(),
    };
    expect(() =>
      createGroundHeights(scene as never, Float64Array.of(1, 2, 3)),
    ).toThrow(/lon, lat pairs/);
  });

  it('refuses a coordinate that is not finite', () => {
    const scene = {
      globe: { getHeight: () => 0, tileLoadProgressEvent: new ProgressEvent() },
      morphComplete: new FakeEvent(),
    };
    expect(() =>
      createGroundHeights(scene as never, Float64Array.of(1, 2, 3, Number.NaN)),
    ).toThrow(/finite lon, lat pairs: pair 1 is \(3, NaN\)/);
  });
});

describe('ground pass measures (e2e build)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    performance.clearMeasures();
  });

  /** Each pick takes 1 ms on the clock the ground heights read. */
  function timedSetup(options: { applied?: boolean } = {}) {
    const clock = { now: 100 };
    const terrain = fakeTerrain(() => 1_000, options);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    const heights = createGroundHeights(
      scene as never,
      POINTS,
      () => clock.now,
    );
    return {
      clock,
      globe: scene.globe,
      heights,
      morphComplete: scene.morphComplete,
      scene,
      terrain,
    };
  }

  const passes = () =>
    performance.getEntriesByName(GROUND_PASS_MEASURE, 'measure').map((e) => ({
      detail: (e as PerformanceMeasure).detail as unknown,
      duration: e.duration,
      startTime: e.startTime,
    }));

  it('measures each pass that reads the ground: the points it picked, its kind and its ms', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const { clock, globe, heights, morphComplete, scene, terrain } =
      timedSetup();
    clock.now = 110;
    heights.resample(); // within 50 ms of the creation sample: no pass
    clock.now = 200;
    scene.preRender.raiseEvent(); // a frame, with its own budget of picks
    terrain.load(() => 1_500); // tiles loaded under both points
    globe.tileLoadProgressEvent.raiseEvent(3);
    clock.now = 300;
    terrain.setRelief(2);
    heights.resample(true); // the relief at rest: followed without a pick
    clock.now = 400;
    globe.tileLoadProgressEvent.raiseEvent(0); // the load queue empty, no tile changed
    clock.now = 410;
    morphComplete.raiseEvent(); // a morph between views complete
    expect(heights.heights()).toEqual(new Float64Array([3_000, 3_000]));
    expect(passes()).toEqual([
      { detail: { kind: 'create', points: 2 }, duration: 2, startTime: 100 },
      { detail: { kind: 'resample', points: 2 }, duration: 2, startTime: 200 },
      { detail: { kind: 'final', points: 0 }, duration: 0, startTime: 300 },
      { detail: { kind: 'final', points: 0 }, duration: 0, startTime: 400 },
      { detail: { kind: 'final', points: 0 }, duration: 0, startTime: 410 },
    ]);
  });

  it('measures no pass while the tiles are still the smooth globe’s', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const { clock, globe, terrain } = timedSetup({ applied: false });
    clock.now = 200;
    globe.tileLoadProgressEvent.raiseEvent(3);
    expect(passes()).toEqual([]);
    terrain.apply();
    clock.now = 300;
    globe.tileLoadProgressEvent.raiseEvent(2);
    expect(passes()).toEqual([
      { detail: { kind: 'resample', points: 2 }, duration: 2, startTime: 300 },
    ]);
  });

  it('measures the passes that carry picks to the next frame as continue', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const clock = { now: 100 };
    const terrain = fakeTerrain(() => 1_000);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    const five = Float64Array.of(-10, 0, -5, 0, 0, 0, 5, 0, 10, 0);
    createGroundHeights(scene as never, five, () => clock.now);
    scene.frame();
    scene.frame();
    expect(passes()).toEqual([
      { detail: { kind: 'create', points: 3 }, duration: 3, startTime: 100 },
      { detail: { kind: 'continue', points: 2 }, duration: 2, startTime: 103 },
    ]);
  });

  it('carries its picks past a frame whose earlier passes spent the budget, without a pass', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '1');
    const clock = { now: 100 };
    const terrain = fakeTerrain(() => 1_000);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    const five = Float64Array.of(-10, 0, -5, 0, 0, 0, 5, 0, 10, 0);
    createGroundHeights(scene as never, five, () => clock.now);
    scene.preRender.raiseEvent();
    terrain.load(() => 2_000); // new tiles under every point, in this frame
    clock.now += GROUND_RESAMPLE_MS;
    scene.globe.tileLoadProgressEvent.raiseEvent(3);
    scene.postRender.raiseEvent(); // the carried pass finds no budget left: it waits
    scene.frame();
    expect(
      passes().map(({ detail }) => detail as { kind: string; points: number }),
    ).toEqual([
      { kind: 'create', points: 3 },
      { kind: 'resample', points: 3 },
      { kind: 'continue', points: 2 },
    ]);
  });

  it('measures nothing outside the e2e build', () => {
    vi.stubEnv('PUBLIC_ATLAS_E2E_HOOKS', '');
    const { clock, heights } = timedSetup();
    clock.now = 300;
    heights.resample(true);
    expect(passes()).toEqual([]);
  });
});

describe('a frame’s budget of ground picks', () => {
  /** Four points around Madrid (odd indices), and four on the far side of the globe. */
  const NEAR_AND_FAR = Float64Array.of(
    176,
    -40,
    -3.7,
    40.4,
    150,
    10,
    2,
    45,
    -170,
    -20,
    -1,
    38,
    160,
    -60,
    5,
    42,
  );
  const OVER_MADRID = Cartographic.fromDegrees(-3.7, 40.4, 2_000_000);

  it('spends at most GROUND_PICK_BUDGET_MS of picks a frame, in view first, carrying the rest to the next', () => {
    expect(GROUND_PICK_BUDGET_MS).toBe(3);
    const clock = { now: 0 };
    const terrain = fakeTerrain(() => 1_000);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    scene.camera.positionCartographic = OVER_MADRID;
    const heights = createGroundHeights(
      scene as never,
      NEAR_AND_FAR,
      () => clock.now,
    );
    const picked = () => terrain.globe.getHeight.mock.calls.length;
    const grounded = () => Array.from(heights.heights(), Number.isFinite);
    expect(picked()).toBe(3);
    // Three of the four points in view; the rest wait for the frame the pass asked for.
    expect(grounded().filter((g, i) => g && i % 2 === 1)).toHaveLength(3);
    expect(scene.requestRender).toHaveBeenCalled();
    scene.frame();
    expect(picked()).toBe(6);
    expect(grounded().filter((g, i) => g && i % 2 === 1)).toHaveLength(4);
    scene.frame();
    expect(picked()).toBe(8);
    expect(grounded().every(Boolean)).toBe(true);
    // Nothing left to carry: no frame is asked for, and none reads the ground again.
    expect(scene.postRender.numberOfListeners).toBe(0);
    scene.frame();
    expect(picked()).toBe(8);
  });

  it('shares a frame’s budget between the passes in it, and between ground heights given one budget', () => {
    const clock = { now: 0 };
    const terrain = fakeTerrain(() => 1_000);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    const budget = createFramePickBudget(scene);
    const picked = () => terrain.globe.getHeight.mock.calls.length;
    const half = NEAR_AND_FAR.subarray(0, 8);
    createGroundHeights(scene as never, half, () => clock.now, budget);
    createGroundHeights(scene as never, half, () => clock.now, budget);
    expect(picked()).toBe(3);
    scene.frame();
    expect(picked()).toBe(6);
    // A frame whose tile loads spend its budget leaves nothing for the carried picks after it.
    scene.preRender.raiseEvent();
    terrain.load(() => 2_000);
    clock.now += GROUND_RESAMPLE_MS;
    scene.globe.tileLoadProgressEvent.raiseEvent(3);
    expect(picked()).toBe(9);
    scene.postRender.raiseEvent();
    expect(picked()).toBe(9);
    budget.destroy();
    expect(scene.preRender.numberOfListeners).toBe(0);
  });

  it('cancels the picks it carries once destroyed, and stops counting frames', () => {
    const clock = { now: 0 };
    const terrain = fakeTerrain(() => 1_000);
    timePicks(terrain, clock);
    const scene = groundScene(terrain);
    const heights = createGroundHeights(
      scene as never,
      NEAR_AND_FAR,
      () => clock.now,
    );
    expect(scene.postRender.numberOfListeners).toBe(1);
    heights.destroy();
    expect(scene.postRender.numberOfListeners).toBe(0);
    expect(scene.preRender.numberOfListeners).toBe(0);
    scene.frame();
    expect(terrain.globe.getHeight).toHaveBeenCalledTimes(3);
  });

  it('picks nothing before World Terrain reaches the tiles, keeping NaN, and starts once it has', () => {
    const clock = { now: 0 };
    const terrain = fakeTerrain(() => 1_000, { applied: false });
    const scene = groundScene(terrain);
    const heights = createGroundHeights(
      scene as never,
      POINTS,
      () => clock.now,
    );
    clock.now = 60;
    scene.globe.tileLoadProgressEvent.raiseEvent(3);
    scene.frame();
    expect(terrain.globe.getHeight).not.toHaveBeenCalled();
    expect(Array.from(heights.heights())).toEqual([Number.NaN, Number.NaN]);
    terrain.apply();
    clock.now = 120;
    scene.globe.tileLoadProgressEvent.raiseEvent(2);
    expect(Array.from(heights.heights())).toEqual([1_000, 1_000]);
  });
});

describe('afterNextRender', () => {
  it('runs once, after the next frame, and asks for that frame', () => {
    const postRender = new FakeEvent(),
      requestRender = vi.fn(),
      run = vi.fn();
    afterNextRender({ postRender, requestRender }, run);
    expect([requestRender.mock.calls.length, run.mock.calls.length]).toEqual([
      1, 0,
    ]);
    postRender.raiseEvent();
    postRender.raiseEvent();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs once removed', () => {
    const postRender = new FakeEvent(),
      run = vi.fn();
    afterNextRender({ postRender, requestRender: vi.fn() }, run)();
    postRender.raiseEvent();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('onTileLoads', () => {
  it('resamples as the tile queue changes, final once it is empty, until removed', () => {
    const globe = { tileLoadProgressEvent: new ProgressEvent() };
    const resample = vi.fn();
    const remove = onTileLoads(globe as never, resample);
    globe.tileLoadProgressEvent.raiseEvent(3);
    globe.tileLoadProgressEvent.raiseEvent(0);
    remove();
    globe.tileLoadProgressEvent.raiseEvent(1);
    expect(resample.mock.calls).toEqual([[false], [true]]);
  });
});

describe('throttleResample', () => {
  it('drops a call within 50 ms of the last that ran, unless it is final', () => {
    const clock = { now: 0 };
    const run = vi.fn();
    const resample = throttleResample(run, () => clock.now);
    resample();
    clock.now = GROUND_RESAMPLE_MS - 1;
    resample();
    resample(true);
    clock.now += GROUND_RESAMPLE_MS - 1;
    resample();
    clock.now += 1;
    resample();
    expect(run.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('counts from the given start, as a fresh sample', () => {
    const clock = { now: 10 };
    const run = vi.fn();
    const resample = throttleResample(run, () => clock.now, clock.now);
    resample();
    clock.now = 10 + GROUND_RESAMPLE_MS;
    resample();
    expect(run.mock.calls).toEqual([[false]]);
  });
});

// Cesium re-exaggerates loaded tiles in the frame after `verticalExaggeration` changes
// (GlobeSurfaceTileProvider.js:555-575), so each re-sample waits for a rendered frame.
describe('createReliefResampler', () => {
  it('resamples after the frame that follows each change, and once more, final, when the changes rest', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const postRender = new FakeEvent(),
      requestRender = vi.fn(),
      resample = vi.fn();
    const relief = createReliefResampler(
      { postRender, requestRender },
      resample,
    );
    relief.changed();
    relief.changed(); // a second change before the frame renders: one re-sample
    expect(resample).not.toHaveBeenCalled();
    postRender.raiseEvent();
    expect(resample.mock.calls).toEqual([[false]]);
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS - 1);
    relief.changed(); // still dragging: the final waits for the slider to rest
    postRender.raiseEvent();
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS - 1);
    postRender.raiseEvent();
    expect(resample.mock.calls).toEqual([[false], [false]]);
    vi.advanceTimersByTime(1);
    expect(resample).toHaveBeenCalledTimes(2); // and then for its frame
    postRender.raiseEvent();
    postRender.raiseEvent();
    expect(resample.mock.calls).toEqual([[false], [false], [true]]);
    expect(requestRender).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('resamples nothing once cancelled', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const postRender = new FakeEvent(),
      resample = vi.fn();
    const relief = createReliefResampler(
      { postRender, requestRender: vi.fn() },
      resample,
    );
    relief.changed();
    relief.cancel();
    postRender.raiseEvent();
    vi.advanceTimersByTime(GROUND_RESAMPLE_MS);
    postRender.raiseEvent();
    expect(resample).not.toHaveBeenCalled();
    expect(postRender.numberOfListeners).toBe(0);
    vi.useRealTimers();
  });
});
