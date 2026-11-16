/** The draped observation groups' ground on World Terrain (terrain draping design, "Per layer under
 * World Terrain": observation symbols; #483): every draped group's picks share one frame's
 * budget, counted only while a group is draped. The footprints are covered through
 * ScientificLayers in atlas-scientific-layers.test.ts. */
import { Cartographic } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Observation } from '../src/atlas/contracts';
import { GROUND_PICK_BUDGET_MS } from '../src/atlas/scene/ground-heights';
import { ObservationDrapes } from '../src/atlas/scene/observation-drapes';
import { FakeEvent } from './helpers/scene-fakes';
import { fakeTerrain } from './helpers/terrain-fakes';

afterEach(() => {
  vi.restoreAllMocks();
});

/** `count` observations around Madrid, in view of a camera over it. */
const near = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => ({ lat: 40 + i / 10, lon: -4 + i / 10 }) as Observation,
  );

function setup() {
  const clock = { now: 0 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const terrain = fakeTerrain(() => 1_000);
  const pick = terrain.globe.getHeight.getMockImplementation()!;
  terrain.globe.getHeight.mockImplementation((c) => {
    clock.now += 1; // each pick takes 1 ms
    return pick(c);
  });
  const preRender = new FakeEvent();
  const postRender = new FakeEvent();
  const scene = {
    camera: {
      positionCartographic: Cartographic.fromDegrees(-3.7, 40.4, 2_000_000),
    },
    globe: Object.assign(terrain.globe, {
      tileLoadProgressEvent: new FakeEvent(),
    }),
    imageryLayers: {},
    morphComplete: new FakeEvent(),
    postRender,
    preRender,
    requestRender: vi.fn(),
  };
  const drapes = new ObservationDrapes({
    // The footprints never build here: their runtime never loads.
    draped: () => new Promise(() => {}),
    onDrapeFailure: vi.fn(),
    scene: scene as never,
    worker: {} as never,
  });
  const group = () =>
    ({
      footprintsShown: () => false,
      setFootprints: vi.fn(),
      setGroundHeights: vi.fn(),
    }) as never;
  const style = { draped: true, samplingAreaColor: '#9af9e2' };
  return { drapes, group, preRender, postRender, scene, style, terrain };
}

describe('the draped observation groups’ ground', () => {
  it('shares one frame’s budget of picks among every draped group', () => {
    const { drapes, group, preRender, postRender, style, terrain } = setup();
    const picked = () => terrain.globe.getHeight.mock.calls.length;
    const frame = () => {
      preRender.raiseEvent();
      postRender.raiseEvent();
    };
    drapes.sync(group(), near(4), 'a', style);
    drapes.sync(group(), near(4), 'b', style);
    expect(picked()).toBe(GROUND_PICK_BUDGET_MS);
    frame();
    expect(picked()).toBe(2 * GROUND_PICK_BUDGET_MS);
    frame();
    expect(picked()).toBe(8);
  });

  it('counts frames only while a group is draped', () => {
    const { drapes, group, preRender, style } = setup();
    expect(preRender.numberOfListeners).toBe(0);
    const a = group();
    const b = group();
    drapes.sync(a, near(1), 'a', style);
    drapes.sync(b, near(1), 'b', style);
    expect(preRender.numberOfListeners).toBe(1);
    drapes.release(a);
    expect(preRender.numberOfListeners).toBe(1);
    drapes.sync(b, near(1), 'b', { ...style, draped: false });
    expect(preRender.numberOfListeners).toBe(0);
    drapes.sync(a, near(1), 'a', style);
    drapes.destroy();
    expect(preRender.numberOfListeners).toBe(0);
  });
});
