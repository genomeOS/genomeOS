/** The scene's reveal-wave driver (#453; fast-load design §B.6.7, amended 2026-10-13). */
import { Cartesian2, Cartesian3, Ellipsoid, SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';

import {
  angleBetween,
  cellReveal,
  REVEAL_WAVE_MS,
  WAVE_COMPLETE_RADIUS,
  waveRadius,
  waveTimeline,
  type Vec3,
} from '../src/atlas/scene/reveal-wave';
import {
  createRevealWave,
  REVEAL_WAVE_MEASURE,
  WAVE_ATTRIBUTE,
  waveViewOf,
  type WaveViewScene,
} from '../src/atlas/scene/reveal-wave-driver';
import { FakeEvent } from './helpers/scene-fakes';

const ORIGIN: Vec3 = [0, 0, 1];
const REACH = 1.2;

function harness(
  options: { hold?: () => number | null; hidden?: boolean } = {},
) {
  const clock = { now: 1_000 };
  const preUpdate = new FakeEvent();
  const postRender = new FakeEvent();
  const scene = { postRender, preUpdate, requestRender: vi.fn() };
  const attributes: string[] = [];
  const measure = vi.fn();
  const visibility = new FakeEvent();
  let hidden = options.hidden ?? false;
  const view = vi.fn(() => ({ origin: ORIGIN, reach: REACH }));
  const wave = createRevealWave({
    hold: options.hold,
    measure,
    now: () => clock.now,
    scene,
    target: {
      setAttribute: (name, value) => {
        expect(name).toBe(WAVE_ATTRIBUTE);
        attributes.push(value);
      },
    },
    view,
    visibility: {
      isHidden: () => hidden,
      onChange: (listener) => visibility.addEventListener(listener),
    },
  });
  /** One rendered frame: Cesium raises preUpdate, draws, then raises postRender. */
  const frame = (advanceMs = 0, drawMs = 0) => {
    clock.now += advanceMs;
    preUpdate.raiseEvent();
    clock.now += drawMs;
    postRender.raiseEvent();
  };
  const hide = () => {
    hidden = true;
    visibility.raiseEvent();
  };
  return {
    attributes,
    clock,
    frame,
    hide,
    measure,
    postRender,
    preUpdate,
    scene,
    view,
    visibility,
    wave,
  };
}

describe('reveal wave driver', () => {
  it('says pending until the first wave and rests with every cell whole', () => {
    const h = harness();
    expect(h.attributes).toEqual(['pending']);
    expect(h.wave.running()).toBe(false);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.preUpdate.numberOfListeners).toBe(0);
  });

  it('starts from the view centre at nothing and follows the timeline on each frame', () => {
    const h = harness();
    h.wave.start(false);
    const timeline = waveTimeline(REACH);

    expect(h.view).toHaveBeenCalledTimes(1);
    expect(h.attributes.at(-1)).toBe('running');
    expect(h.wave.running()).toBe(true);
    expect(h.wave.uniforms.origin).toEqual({ x: 0, y: 0, z: 1 });
    expect(h.wave.uniforms.band).toBeCloseTo(timeline.band);
    expect(h.wave.uniforms.radius).toBe(0);
    expect(h.scene.requestRender).toHaveBeenCalled();

    // The clock starts once the wave's first frame is drawn, not at the call.
    h.clock.now += 5_000;
    h.frame();
    expect(h.wave.uniforms.radius).toBe(0);
    for (const step of [100, 200, 300]) {
      h.scene.requestRender.mockClear();
      h.frame(100);
      expect(h.wave.uniforms.radius).toBeCloseTo(waveRadius(timeline, step));
      expect(h.scene.requestRender).toHaveBeenCalledTimes(1);
    }
  });

  it('starts its clock once its first frame is drawn, so a slow first frame takes none of it', () => {
    // The first frame of a wave can compile shaders and upload the first chunk (~230 ms on an
    // M3 Pro); the ring must not be a third of the way out by the time anything shows.
    const h = harness();
    h.wave.start(false);
    h.frame(0, 230);
    expect(h.wave.uniforms.radius).toBe(0);
    h.frame(16);
    expect(h.wave.uniforms.radius).toBeCloseTo(
      waveRadius(waveTimeline(REACH), 16),
    );
  });

  it('ends at the horizon with a measure and stops requesting renders', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    const started = h.clock.now;
    for (let step = 0; step < 7; step += 1) h.frame(100);
    h.frame(99);
    expect(h.wave.running()).toBe(true);
    h.frame(1);

    expect(h.wave.running()).toBe(false);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.attributes).toEqual(['pending', 'running', 'done']);
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(h.measure).toHaveBeenCalledWith(
      REVEAL_WAVE_MEASURE,
      started,
      started + REVEAL_WAVE_MS,
      expect.objectContaining({ reach: REACH }),
    );
    expect(h.preUpdate.numberOfListeners).toBe(0);
    expect(h.postRender.numberOfListeners).toBe(0);
    expect(h.visibility.numberOfListeners).toBe(0);
    h.scene.requestRender.mockClear();
    for (let index = 0; index < 5; index += 1) h.frame(16);
    expect(h.scene.requestRender).not.toHaveBeenCalled();
    expect(REVEAL_WAVE_MEASURE).toBe('atlas:reveal-wave');
  });

  it('shows everything at once under reduced motion', () => {
    const h = harness();
    h.wave.start(true);

    expect(h.wave.running()).toBe(false);
    expect(h.view).not.toHaveBeenCalled();
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.attributes).toEqual(['pending', 'done']);
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.preUpdate.numberOfListeners).toBe(0);
  });

  it('cuts a running wave short when reduced motion starts the next one', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    h.frame(100);
    h.wave.start(true);
    expect(h.wave.running()).toBe(false);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.attributes.at(-1)).toBe('done');
    expect(h.preUpdate.numberOfListeners).toBe(0);
  });

  it('finishes at once when the tab is hidden mid-wave', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    h.frame(200);
    h.hide();

    expect(h.wave.running()).toBe(false);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.attributes.at(-1)).toBe('done');
    expect(h.measure).toHaveBeenCalledTimes(1);
    expect(h.preUpdate.numberOfListeners).toBe(0);
    expect(h.visibility.numberOfListeners).toBe(0);
    // The hidden tab draws the finished surface on its next frame.
    expect(h.scene.requestRender).toHaveBeenCalled();
  });

  it('runs no wave in a hidden tab', () => {
    const h = harness({ hidden: true });
    h.wave.start(false);
    expect(h.wave.running()).toBe(false);
    expect(h.attributes).toEqual(['pending', 'done']);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
  });

  it('restarts from the centre when a new wave starts mid-wave', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    h.frame(300);
    expect(h.wave.uniforms.radius).toBeGreaterThan(0);
    h.wave.start(false);
    expect(h.wave.uniforms.radius).toBe(0);
    expect(h.preUpdate.numberOfListeners).toBe(1);
    h.frame(1_000);
    // The new wave's clock starts at its own first frame.
    expect(h.wave.uniforms.radius).toBe(0);
    expect(h.wave.running()).toBe(true);
  });

  it('tells listeners when a wave starts and when it ends, once each', () => {
    const h = harness();
    const changes: boolean[] = [];
    const remove = h.wave.onChange((running) => changes.push(running));
    h.wave.start(false);
    h.wave.start(false);
    h.frame();
    for (let step = 0; step < 4; step += 1) h.frame(REVEAL_WAVE_MS / 4);
    h.wave.start(true);
    expect(changes).toEqual([true, false]);
    remove();
    h.wave.start(false);
    expect(changes).toEqual([true, false]);
  });

  it('can be finished at once', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    h.wave.finish();
    expect(h.wave.running()).toBe(false);
    expect(h.wave.uniforms.radius).toBe(WAVE_COMPLETE_RADIUS);
    expect(h.attributes.at(-1)).toBe('done');
    h.wave.finish();
    expect(h.measure).toHaveBeenCalledTimes(1);
  });

  it('answers how far it has grown a cell, as the shaders do', () => {
    const h = harness();
    expect(h.wave.reveal([1, 0, 0])).toBe(1);
    h.wave.start(false);
    h.frame();
    h.frame(150);
    const { band, radius } = h.wave.uniforms;
    for (const direction of [
      [0, 0, 1],
      [0.3, 0, 1],
      [1, 0, 1],
      [1, 0, -1],
    ] as Vec3[])
      expect(h.wave.reveal(direction)).toBe(
        cellReveal(angleBetween(direction, ORIGIN), radius, band),
      );
    expect(h.wave.reveal([0, 0, 1])).toBe(1);
    expect(h.wave.reveal([1, 0, -1])).toBe(0);
  });

  it('stands still at a held progress and runs on once released (e2e builds only)', () => {
    let hold: number | null = 0;
    const h = harness({ hold: () => hold });
    const timeline = waveTimeline(REACH);
    h.wave.start(false);
    h.frame();
    h.frame(5_000);
    expect(h.wave.running()).toBe(true);
    expect(h.wave.uniforms.radius).toBe(0);
    hold = 0.25;
    h.frame(16);
    expect(h.wave.uniforms.radius).toBeCloseTo(
      waveRadius(timeline, 0.25 * REVEAL_WAVE_MS),
    );
    // A held wave draws nothing new, so it requests no render until the hold moves.
    h.scene.requestRender.mockClear();
    h.frame(16);
    h.frame(16);
    expect(h.scene.requestRender).not.toHaveBeenCalled();
    hold = 0.5;
    h.frame(16);
    expect(h.scene.requestRender).toHaveBeenCalledTimes(1);
    // Released, it runs on from where it stood, not from its first frame.
    hold = null;
    h.frame(16);
    expect(h.wave.running()).toBe(true);
    expect(h.wave.uniforms.radius).toBeCloseTo(
      waveRadius(timeline, 0.5 * REVEAL_WAVE_MS + 16),
    );
    h.frame(200);
    h.frame(184);
    expect(h.wave.running()).toBe(false);
    expect(h.attributes.at(-1)).toBe('done');
  });

  it('lets a stalled frame move the wave by at most a quarter of its duration', () => {
    // A long task or a texture upload can hold one frame for 0.6–0.8 s; the ring must then go
    // on spreading, not pop to the end.
    const h = harness();
    const timeline = waveTimeline(REACH);
    h.wave.start(false);
    h.frame();
    h.frame(700);
    expect(h.wave.running()).toBe(true);
    expect(h.wave.uniforms.radius).toBeCloseTo(
      waveRadius(timeline, REVEAL_WAVE_MS / 4),
    );
    h.frame(16);
    expect(h.wave.uniforms.radius).toBeCloseTo(
      waveRadius(timeline, REVEAL_WAVE_MS / 4 + 16),
    );
  });

  it('writes nothing and requests nothing once destroyed', () => {
    const h = harness();
    h.wave.start(false);
    h.frame();
    h.wave.destroy();
    expect(h.preUpdate.numberOfListeners).toBe(0);
    expect(h.postRender.numberOfListeners).toBe(0);
    expect(h.visibility.numberOfListeners).toBe(0);
    const writes = h.attributes.length;
    h.scene.requestRender.mockClear();
    h.wave.start(false);
    h.wave.start(true);
    h.wave.finish();
    expect(h.attributes).toHaveLength(writes);
    expect(h.scene.requestRender).not.toHaveBeenCalled();
  });
});

function fakeViewScene(
  overrides: Partial<{
    mode: SceneMode;
    position: Cartesian3;
    direction: Cartesian3;
    pick: (point: Cartesian2) => Cartesian3 | undefined;
  }> = {},
): WaveViewScene {
  const position =
    overrides.position ?? Cartesian3.fromDegrees(20, 12, 16_500_000);
  return {
    camera: {
      directionWC:
        overrides.direction ??
        Cartesian3.negate(
          Cartesian3.normalize(position, new Cartesian3()),
          new Cartesian3(),
        ),
      pickEllipsoid: overrides.pick ?? (() => undefined),
      positionCartographic: Ellipsoid.WGS84.cartesianToCartographic(position),
      positionWC: position,
    },
    canvas: { clientHeight: 600, clientWidth: 800 },
    mode: overrides.mode ?? SceneMode.SCENE3D,
  };
}

function direction(point: Cartesian3): Vec3 {
  return [point.x, point.y, point.z];
}

describe('reveal wave view', () => {
  it('starts where the camera’s view ray meets the globe', () => {
    const position = Cartesian3.fromDegrees(20, 12, 16_500_000);
    const target = Cartesian3.fromDegrees(30, 20, 0);
    const look = Cartesian3.normalize(
      Cartesian3.subtract(target, position, new Cartesian3()),
      new Cartesian3(),
    );
    const view = waveViewOf(fakeViewScene({ direction: look, position }), 0);
    expect(angleBetween(view.origin, direction(target))).toBeLessThan(1e-6);
  });

  it('falls back to the point below the camera when the view ray misses the globe', () => {
    const position = Cartesian3.fromDegrees(20, 12, 16_500_000);
    const skyward = Cartesian3.normalize(position, new Cartesian3());
    const view = waveViewOf(fakeViewScene({ direction: skyward, position }), 0);
    expect(angleBetween(view.origin, direction(position))).toBeLessThan(1e-9);
  });

  it('runs to the horizon, lifted cells included, when the globe does not fill the view', () => {
    const radius = Ellipsoid.WGS84.minimumRadius;
    const distance = Cartesian3.magnitude(
      Cartesian3.fromDegrees(20, 12, 16_500_000),
    );
    expect(waveViewOf(fakeViewScene(), 0).reach).toBeCloseTo(
      Math.acos(radius / distance),
      9,
    );
    expect(waveViewOf(fakeViewScene(), 900_000).reach).toBeCloseTo(
      Math.acos(radius / distance) + Math.acos(radius / (radius + 900_000)),
      9,
    );
  });

  it('stops at the edge of a view the globe fills', () => {
    const position = Cartesian3.fromDegrees(-3.7, 40.4, 1_000_000);
    const picks: Cartesian2[] = [];
    const view = waveViewOf(
      fakeViewScene({
        pick: (point) => {
          picks.push(Cartesian2.clone(point));
          return Cartesian3.fromDegrees(
            -3.7 + (point.x - 400) / 100,
            40.4 + (300 - point.y) / 100,
          );
        },
        position,
      }),
      0,
    );
    // Corners and edge midpoints of the canvas.
    expect(picks).toHaveLength(8);
    expect(picks.map(({ x, y }) => `${x},${y}`).sort()).toEqual(
      [
        '0,0',
        '400,0',
        '800,0',
        '800,300',
        '800,600',
        '400,600',
        '0,600',
        '0,300',
      ].sort(),
    );
    const corners = [
      [-4, -3],
      [-4, 3],
      [4, -3],
      [4, 3],
    ].map(([lon, lat]) =>
      angleBetween(
        view.origin,
        direction(Cartesian3.fromDegrees(-3.7 + lon, 40.4 + lat)),
      ),
    );
    expect(view.reach).toBeCloseTo(Math.max(...corners), 9);
  });

  it('reads the map frame through the camera’s ellipsoid picks in 2D and Columbus view', () => {
    const centre = Cartesian3.fromDegrees(10, 5);
    for (const mode of [SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW]) {
      const view = waveViewOf(
        fakeViewScene({
          mode,
          pick: (point) =>
            point.x === 400 && point.y === 300 ? centre : undefined,
        }),
        0,
      );
      expect(angleBetween(view.origin, direction(centre))).toBeLessThan(1e-9);
      // Part of the map edge shows no globe: the whole globe is in reach.
      expect(view.reach).toBe(Math.PI);
    }
  });
});
