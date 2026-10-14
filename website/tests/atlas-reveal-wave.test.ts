/** The surface reveal wave's pure timeline and geometry (#453; fast-load design §B.6.7, amended 2026-10-13
 * and 2026-10-14). */
import { describe, expect, it } from 'vitest';

import {
  angleAtFraction,
  angleAtScreenDistance,
  angleBetween,
  cellReveal,
  horizonReach,
  MIN_WAVE_REACH,
  REVEAL_WAVE_BAND_FRACTION,
  REVEAL_WAVE_EASE_SHARE,
  REVEAL_WAVE_MS,
  screenDistance,
  WAVE_COMPLETE_RADIUS,
  waveDone,
  waveEase,
  waveFront,
  waveOrigin,
  waveReach,
  waveStep,
  waveTimeline,
  type Vec3,
  type WaveTimeline,
} from '../src/atlas/scene/reveal-wave';

const EARTH = 6_371_000;

function fromDegrees(lat: number, lon: number, radius = EARTH): Vec3 {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  return [
    radius * Math.cos(phi) * Math.cos(lambda),
    radius * Math.cos(phi) * Math.sin(lambda),
    radius * Math.sin(phi),
  ];
}

/** The home view: a camera 16,500 km straight above the origin, so the horizon is 73.9° away. */
const HOME_EYE = 1 + 16_500_000 / EARTH;
const HOME_HORIZON = Math.acos(1 / HOME_EYE);

/** The leading edge's on-screen distance from the origin, as a fraction of the limb's. */
function onScreen(timeline: WaveTimeline, angle: number): number {
  return (
    screenDistance(angle, timeline.eye) /
    screenDistance(timeline.limb, timeline.eye)
  );
}

describe('reveal wave timeline', () => {
  it('grows every visible cell in about 1 s, one tunable constant', () => {
    expect(REVEAL_WAVE_MS).toBe(1_000);
    expect(waveTimeline(1, HOME_EYE).durationMs).toBe(REVEAL_WAVE_MS);
    expect(waveTimeline(1, HOME_EYE, 400).durationMs).toBe(400);
  });

  it('runs at one speed and eases out gently over the last fifth only', () => {
    expect(waveEase(0)).toBe(0);
    expect(waveEase(1)).toBe(1);
    expect(waveEase(-1)).toBe(0);
    expect(waveEase(2)).toBe(1);
    expect(REVEAL_WAVE_EASE_SHARE).toBe(0.2);
    // Equal times cover equal distances until the ease begins.
    const speed = waveEase(0.1) / 0.1;
    for (const t of [0.2, 0.4, 0.6, 0.8])
      expect(waveEase(t)).toBeCloseTo(speed * t, 12);
    // No jump in speed where the ease begins, and at rest at the end.
    const slope = (t: number) =>
      (waveEase(t + 1e-6) - waveEase(t - 1e-6)) / 2e-6;
    expect(slope(0.8)).toBeCloseTo(speed, 4);
    expect(slope(1 - 1e-6)).toBeLessThan(0.01);
    let previous = 0;
    for (let step = 1; step <= 100; step += 1) {
      const value = waveEase(step / 100);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('projects angles on screen as the globe draws them, out to the horizon', () => {
    // A point at the horizon draws at the limb: tan(asin(1 / eye)) of the focal length.
    expect(screenDistance(HOME_HORIZON, HOME_EYE)).toBeCloseTo(
      Math.tan(Math.asin(1 / HOME_EYE)),
      12,
    );
    // From the home view, the outer half of the angle draws in the outer quarter of the disc.
    expect(
      screenDistance(HOME_HORIZON / 2, HOME_EYE) /
        screenDistance(HOME_HORIZON, HOME_EYE),
    ).toBeCloseTo(0.74, 2);
    for (const angle of [-0.3, 0, 0.01, 0.5, 1, HOME_HORIZON])
      expect(
        angleAtScreenDistance(screenDistance(angle, HOME_EYE), HOME_EYE),
      ).toBeCloseTo(angle, 12);
    // The map frame (2D and Columbus view) draws distance as the angle.
    expect(screenDistance(0.7, null)).toBe(0.7);
    expect(angleAtScreenDistance(0.7, null)).toBe(0.7);
  });

  it('meets the limb at the horizon, or at the edge of a view the globe fills', () => {
    const home = waveTimeline(HOME_HORIZON + 0.02, HOME_EYE);
    expect(home.reach).toBeCloseTo(HOME_HORIZON + 0.02);
    expect(home.limb).toBeCloseTo(HOME_HORIZON, 12);
    const filled = waveTimeline(0.3, 1.2);
    expect(filled.limb).toBe(0.3);
    const map = waveTimeline(1.1, null);
    expect(map.limb).toBe(1.1);
    expect(map.eye).toBeNull();
    // A camera at or inside the globe has no horizon: the angle stands in.
    expect(waveTimeline(1.1, 1).eye).toBeNull();
    expect(waveTimeline(1.1, 0.5).limb).toBe(1.1);
  });

  it('clamps the reach to (0, π] so the ring never has zero width', () => {
    expect(waveTimeline(0, HOME_EYE).reach).toBe(MIN_WAVE_REACH);
    expect(waveTimeline(-1, HOME_EYE).reach).toBe(MIN_WAVE_REACH);
    expect(waveTimeline(Number.NaN, HOME_EYE).reach).toBe(Math.PI);
    expect(waveTimeline(7, null).reach).toBe(Math.PI);
    expect(waveFront(waveTimeline(0, HOME_EYE), 0).band).toBeGreaterThan(0);
    expect(waveFront(waveTimeline(0, null), 500).band).toBeGreaterThan(0);
  });

  it('grows the ring’s on-screen radius evenly from the centre to the limb', () => {
    const timeline = waveTimeline(HOME_HORIZON + 0.01, HOME_EYE);
    expect(waveFront(timeline, 0).radius).toBe(0);
    expect(waveFront(timeline, -50).radius).toBe(0);
    // Equal times move the leading edge equal distances on screen, not equal angles.
    const at = (ms: number) =>
      onScreen(timeline, waveFront(timeline, ms).radius);
    const step = at(100);
    for (const ms of [200, 300, 400, 500, 600, 700])
      expect(at(ms)).toBeCloseTo((step * ms) / 100, 9);
    // The leading edge is about a seventh of the way out at 0.1 s and meets the limb at 0.75 s.
    expect(at(100)).toBeCloseTo(0.133, 3);
    expect(at(200)).toBeCloseTo(0.267, 3);
    expect(at(400)).toBeCloseTo(0.533, 3);
    expect(at(600)).toBeCloseTo(0.8, 3);
    expect(at(750)).toBeCloseTo(1, 3);
    let previous = 0;
    for (let ms = 10; ms < REVEAL_WAVE_MS; ms += 10) {
      const radius = waveFront(timeline, ms).radius;
      expect(radius).toBeGreaterThan(previous);
      previous = radius;
    }
  });

  it('keeps the ring a fifth of the way to the limb wide on screen', () => {
    const timeline = waveTimeline(HOME_HORIZON, HOME_EYE);
    for (const ms of [200, 400, 600]) {
      const front = waveFront(timeline, ms);
      const lead = onScreen(timeline, front.radius);
      expect(onScreen(timeline, front.radius - front.band)).toBeCloseTo(
        lead - REVEAL_WAVE_BAND_FRACTION,
        9,
      );
    }
    // The globe squeezes angles towards its limb, so the same width on screen is a narrow angle
    // near the centre and a wide one near the limb.
    expect(waveFront(timeline, 600).band).toBeGreaterThan(
      1.4 * waveFront(timeline, 200).band,
    );
    expect(REVEAL_WAVE_BAND_FRACTION).toBeGreaterThan(0);
    expect(REVEAL_WAVE_BAND_FRACTION).toBeLessThan(0.5);
  });

  it('times the map frame evenly in angle', () => {
    const timeline = waveTimeline(1.2, null);
    expect(waveFront(timeline, 300).radius).toBeCloseTo(
      2 * waveFront(timeline, 150).radius,
      12,
    );
    expect(waveFront(timeline, 300).band).toBeCloseTo(
      1.2 * REVEAL_WAVE_BAND_FRACTION,
      12,
    );
  });

  it('has every cell up to the horizon fully grown when it ends', () => {
    const timeline = waveTimeline(HOME_HORIZON, HOME_EYE);
    // Just before the end the limb cell is nearly grown; at the end every visible cell is.
    const last = waveFront(timeline, REVEAL_WAVE_MS - 1);
    expect(cellReveal(timeline.limb, last.radius, last.band)).toBeGreaterThan(
      0.99,
    );
    const end = waveFront(timeline, REVEAL_WAVE_MS);
    for (const angle of [0, 0.4, 1.0, HOME_HORIZON])
      expect(cellReveal(angle, end.radius, end.band)).toBe(1);
    expect(waveDone(timeline, REVEAL_WAVE_MS - 1)).toBe(false);
    expect(waveDone(timeline, REVEAL_WAVE_MS)).toBe(true);
  });

  it('carries the ring past the limb as the globe draws it, so cells at the limb grow with it', () => {
    const timeline = waveTimeline(HOME_HORIZON + 0.05, HOME_EYE);
    expect(angleAtFraction(timeline, 1)).toBeCloseTo(HOME_HORIZON, 9);
    // Past the horizon the distance mirrors the projection about it.
    for (const past of [0.05, 0.1, 0.2])
      expect(angleAtFraction(timeline, 1 + past) - HOME_HORIZON).toBeCloseTo(
        HOME_HORIZON - angleAtFraction(timeline, 1 - past),
        9,
      );
    // A cell at the limb grows about as far as the ring's position on screen says: late in the
    // wave the leading edge is past the limb, and the cell has grown that far into the ring's
    // width (the shaders interpolate within the ring in angle, so it is within a sixth of it,
    // not exact, and all but grown just before the end).
    let previous = 0;
    for (const t of [0.8, 0.85, 0.9, 0.95]) {
      const lead = (1 + REVEAL_WAVE_BAND_FRACTION) * waveEase(t);
      const front = waveFront(timeline, t * REVEAL_WAVE_MS);
      const grown = cellReveal(HOME_HORIZON, front.radius, front.band);
      expect(front.radius).toBeGreaterThan(HOME_HORIZON);
      expect(
        Math.abs(grown - (lead - 1) / REVEAL_WAVE_BAND_FRACTION),
      ).toBeLessThan(1 / 6);
      expect(grown).toBeGreaterThan(previous);
      previous = grown;
    }
    const nearEnd = waveFront(timeline, 0.99 * REVEAL_WAVE_MS);
    expect(
      cellReveal(HOME_HORIZON, nearEnd.radius, nearEnd.band),
    ).toBeGreaterThan(0.95);
    // Lifted cells just past the horizon have begun by the end; the rest finish with the wave.
    const last = waveFront(timeline, REVEAL_WAVE_MS - 1);
    expect(last.radius).toBeGreaterThan(HOME_HORIZON + 0.05);
    // A view the globe fills: past its edge the ring follows the projection itself.
    const filled = waveTimeline(0.3, 1.2);
    expect(
      screenDistance(angleAtFraction(filled, 1.1), 1.2) /
        screenDistance(0.3, 1.2),
    ).toBeCloseTo(1.1, 9);
  });

  it('finishes the far side at once', () => {
    const timeline = waveTimeline(HOME_HORIZON, HOME_EYE);
    expect(waveFront(timeline, REVEAL_WAVE_MS).radius).toBe(
      WAVE_COMPLETE_RADIUS,
    );
    expect(waveFront(timeline, 5_000).radius).toBe(WAVE_COMPLETE_RADIUS);
    // Beyond the horizon, the antipode included, nothing waits once the wave is done.
    expect(cellReveal(Math.PI, WAVE_COMPLETE_RADIUS, 1)).toBe(1);
    // The sentinel lies beyond any angle plus any band.
    expect(WAVE_COMPLETE_RADIUS).toBeGreaterThan(
      Math.PI * (1 + REVEAL_WAVE_BAND_FRACTION),
    );
  });

  it('advances by a frame’s time, but a stalled frame by at most a quarter of the wave', () => {
    const timeline = waveTimeline(1.3, HOME_EYE);
    expect(waveStep(timeline, 16)).toBe(16);
    expect(waveStep(timeline, 120)).toBe(120);
    // A 700 ms stall (a long task or a texture upload) leaves most of the wave to be seen.
    expect(waveStep(timeline, 700)).toBe(REVEAL_WAVE_MS / 4);
    expect(waveStep(waveTimeline(1.3, HOME_EYE, 400), 700)).toBe(100);
    expect(waveStep(timeline, -5)).toBe(0);
  });

  it('grows a cell from nothing at the ring’s leading edge to full one ring width behind it', () => {
    const band = 0.2;
    expect(cellReveal(0.5, 0.5, band)).toBe(0);
    expect(cellReveal(0.6, 0.5, band)).toBe(0);
    expect(cellReveal(0.4, 0.5, band)).toBeCloseTo(0.5);
    expect(cellReveal(0.3, 0.5, band)).toBe(1);
    expect(cellReveal(0, 0.5, band)).toBe(1);
  });

  it('shows the view centre early and the limb only later', () => {
    const timeline = waveTimeline(HOME_HORIZON, HOME_EYE);
    // A quarter of the way through, the centre is grown and nothing past half way has begun.
    const early = waveFront(timeline, 0.25 * REVEAL_WAVE_MS);
    expect(cellReveal(0, early.radius, early.band)).toBe(1);
    expect(cellReveal(0.06, early.radius, early.band)).toBe(1);
    const halfWay = angleAtFraction(timeline, 0.5);
    expect(cellReveal(halfWay, early.radius, early.band)).toBe(0);
    expect(cellReveal(1.2, early.radius, early.band)).toBe(0);
  });
});

describe('reveal wave origin and reach', () => {
  it('measures angles between directions of any length', () => {
    expect(angleBetween([1, 0, 0], [0, 5, 0])).toBeCloseTo(Math.PI / 2);
    expect(angleBetween([2, 0, 0], [3, 0, 0])).toBe(0);
    expect(angleBetween([1, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI);
    // Rounding past ±1 never yields NaN.
    expect(angleBetween([1, 1e-9, 0], [1, 0, 0])).not.toBeNaN();
  });

  it('starts where the view ray meets the globe', () => {
    const hit = fromDegrees(12, 20);
    const origin = waveOrigin(hit, fromDegrees(0, 0, 3 * EARTH));
    expect(Math.hypot(...origin)).toBeCloseTo(1);
    expect(angleBetween(origin, hit)).toBeCloseTo(0, 9);
  });

  it('falls back to the point below the camera when the view ray misses the globe', () => {
    const camera = fromDegrees(-30, 140, 2 * EARTH);
    const origin = waveOrigin(null, camera);
    expect(Math.hypot(...origin)).toBeCloseTo(1);
    expect(angleBetween(origin, camera)).toBeCloseTo(0, 9);
  });

  it('reaches the horizon seen from the camera, past the origin’s offset from the nadir', () => {
    const camera = fromDegrees(12, 20, EARTH + 16_500_000);
    const below = waveOrigin(null, camera);
    const cap = Math.acos(EARTH / (EARTH + 16_500_000));
    expect(horizonReach(below, camera, 0, EARTH)).toBeCloseTo(cap);
    // An origin 10° from the nadir has its far horizon 10° further away.
    const offset = waveOrigin(fromDegrees(22, 20), camera);
    expect(horizonReach(offset, camera, 0, EARTH)).toBeCloseTo(
      cap + (10 * Math.PI) / 180,
    );
  });

  it('reaches further for lifted cells, which show above the horizon', () => {
    const camera = fromDegrees(0, 0, 3 * EARTH);
    const origin = waveOrigin(null, camera);
    const flat = horizonReach(origin, camera, 0, EARTH);
    const lifted = horizonReach(origin, camera, 900_000, EARTH);
    expect(lifted).toBeCloseTo(flat + Math.acos(EARTH / (EARTH + 900_000)));
  });

  it('covers the whole globe from a camera at or below its surface', () => {
    const camera = fromDegrees(0, 0, EARTH);
    expect(horizonReach(waveOrigin(null, camera), camera, 0, EARTH)).toBe(
      Math.PI,
    );
    const far = fromDegrees(0, 0, 1e9);
    expect(
      horizonReach(waveOrigin(fromDegrees(0, 180), far), far, 0, EARTH),
    ).toBe(Math.PI);
  });

  it('stops at the edge of a zoomed-in view instead of the far horizon', () => {
    const camera = fromDegrees(40, -4, EARTH + 1_000_000);
    const origin = waveOrigin(fromDegrees(40, -4), camera);
    const border = [
      fromDegrees(45, -9),
      fromDegrees(45, 1),
      fromDegrees(35, 1),
      fromDegrees(35, -9),
    ];
    const reach = waveReach(origin, camera, 0, border, EARTH);
    const farthest = Math.max(...border.map((p) => angleBetween(origin, p)));
    expect(reach).toBeCloseTo(farthest);
    expect(reach).toBeLessThan(horizonReach(origin, camera, 0, EARTH));
  });

  it('runs to the horizon whenever part of the view’s edge is sky', () => {
    const camera = fromDegrees(12, 20, EARTH + 16_500_000);
    const origin = waveOrigin(fromDegrees(12, 20), camera);
    const border = [fromDegrees(13, 21), null];
    expect(waveReach(origin, camera, 0, border, EARTH)).toBe(
      horizonReach(origin, camera, 0, EARTH),
    );
    expect(waveReach(origin, camera, 0, [], EARTH)).toBe(
      horizonReach(origin, camera, 0, EARTH),
    );
  });
});
