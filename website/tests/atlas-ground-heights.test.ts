/** Ground heights under World Terrain: sampling, throttling and the triggers that re-sample them
 * (terrain draping design, "Per layer under World Terrain", "Exaggeration", "2D and Columbus" and
 * "Failure modes"; #483). */
import { Math as CesiumMath, type Cartographic } from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import {
  afterNextRender,
  createGroundHeights,
  GROUND_RESAMPLE_MS,
  sampleGroundHeights,
} from '../src/atlas/scene/ground-heights';
import { FakeEvent } from './helpers/scene-fakes';

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

function setup(initial: (lon: number) => number | undefined) {
  const clock = { now: 0 };
  let ground = initial;
  const globe = {
    getHeight: vi.fn((c: Cartographic) =>
      ground(CesiumMath.toDegrees(c.longitude)),
    ),
    tileLoadProgressEvent: new ProgressEvent(),
  };
  const morphComplete = new FakeEvent();
  const heights = createGroundHeights(
    { globe, morphComplete } as never,
    POINTS,
    () => clock.now,
  );
  return {
    clock,
    globe,
    heights,
    morphComplete,
    setGround: (next: typeof initial) => {
      ground = next;
    },
  };
}

describe('ground heights under World Terrain', () => {
  it('samples the rendered ground under each point, NaN where no tile has loaded', () => {
    const globe = {
      getHeight: (c: Cartographic) =>
        CesiumMath.toDegrees(c.longitude) < 0 ? 6_000 : undefined,
    };
    expect(Array.from(sampleGroundHeights(globe as never, POINTS))).toEqual([
      6_000,
      Number.NaN,
    ]);
    const out = new Float64Array(2);
    expect(sampleGroundHeights(globe as never, POINTS, out)).toBe(out);
  });

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

  it('stops listening once destroyed, and tells no unsubscribed listener', () => {
    const { globe, heights, morphComplete, setGround } = setup(() => 1_000);
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

  it('refuses a coordinate that is not finite, and an out array of the wrong length', () => {
    const scene = {
      globe: { getHeight: () => 0, tileLoadProgressEvent: new ProgressEvent() },
      morphComplete: new FakeEvent(),
    };
    expect(() =>
      createGroundHeights(scene as never, Float64Array.of(1, 2, 3, Number.NaN)),
    ).toThrow(/finite lon, lat pairs: pair 1 is \(3, NaN\)/);
    expect(() =>
      sampleGroundHeights(scene.globe, POINTS, new Float64Array(3)),
    ).toThrow(/2 points need 2 slots: got 3/);
  });

  it('wraps a longitude past 180° into the range where getHeight finds its tiles', () => {
    // Globe.getHeight finds no level-zero tile for a longitude outside [-180°, 180°].
    const globe = {
      getHeight: (c: Cartographic) =>
        Math.abs(c.longitude) <= Math.PI ? 6_000 : undefined,
    };
    const shifted = Float64Array.of(-3.709 + 360, 40.419, 12.686 - 360, -1.844);
    expect(Array.from(sampleGroundHeights(globe as never, shifted))).toEqual([
      6_000, 6_000,
    ]);
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
