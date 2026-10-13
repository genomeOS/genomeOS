/** The surface reveal wave's pure timeline and geometry (#453; fast-load design §B.6.7, amended 2026-10-13). */
import { describe, expect, it } from 'vitest';

import {
  angleBetween,
  cellReveal,
  easeOutCubic,
  horizonReach,
  MIN_WAVE_REACH,
  REVEAL_WAVE_BAND_FRACTION,
  REVEAL_WAVE_MS,
  WAVE_COMPLETE_RADIUS,
  waveDone,
  waveOrigin,
  waveRadius,
  waveReach,
  waveTimeline,
  type Vec3,
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

describe('reveal wave timeline', () => {
  it('reaches the horizon in about 0.8 s, one tunable constant', () => {
    expect(REVEAL_WAVE_MS).toBe(800);
    expect(waveTimeline(1).durationMs).toBe(REVEAL_WAVE_MS);
    expect(waveTimeline(1, 400).durationMs).toBe(400);
  });

  it('eases out: fast at first, slowing to rest at the end', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    // Ease-out covers more than half the way in the first half of the time.
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    let previous = 0;
    for (let step = 1; step <= 100; step += 1) {
      const value = easeOutCubic(step / 100);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('gives the ring a width proportional to the angle it covers', () => {
    const timeline = waveTimeline(1.2);
    expect(timeline.reach).toBe(1.2);
    expect(timeline.band).toBeCloseTo(1.2 * REVEAL_WAVE_BAND_FRACTION);
    expect(REVEAL_WAVE_BAND_FRACTION).toBeGreaterThan(0);
    expect(REVEAL_WAVE_BAND_FRACTION).toBeLessThan(0.5);
  });

  it('clamps the reach to (0, π] so the ring never has zero width', () => {
    expect(waveTimeline(0).reach).toBe(MIN_WAVE_REACH);
    expect(waveTimeline(-1).reach).toBe(MIN_WAVE_REACH);
    expect(waveTimeline(Number.NaN).reach).toBe(Math.PI);
    expect(waveTimeline(7).reach).toBe(Math.PI);
    expect(waveTimeline(0).band).toBeGreaterThan(0);
  });

  it('starts at the origin and grows monotonically', () => {
    const timeline = waveTimeline(1.3);
    expect(waveRadius(timeline, 0)).toBe(0);
    expect(waveRadius(timeline, -50)).toBe(0);
    let previous = 0;
    for (let ms = 10; ms < REVEAL_WAVE_MS; ms += 10) {
      const radius = waveRadius(timeline, ms);
      expect(radius).toBeGreaterThan(previous);
      previous = radius;
    }
  });

  it('has every cell up to the horizon fully grown when it ends', () => {
    const timeline = waveTimeline(1.3);
    // Just before the end the horizon cell is nearly grown; at the end every visible cell is.
    expect(
      cellReveal(timeline.reach, waveRadius(timeline, 799), timeline.band),
    ).toBeGreaterThan(0.99);
    for (const angle of [0, 0.4, 1.0, 1.3])
      expect(cellReveal(angle, waveRadius(timeline, 800), timeline.band)).toBe(
        1,
      );
    expect(waveDone(timeline, 799)).toBe(false);
    expect(waveDone(timeline, 800)).toBe(true);
  });

  it('finishes the far side at once', () => {
    const timeline = waveTimeline(1.3);
    expect(waveRadius(timeline, 800)).toBe(WAVE_COMPLETE_RADIUS);
    expect(waveRadius(timeline, 5_000)).toBe(WAVE_COMPLETE_RADIUS);
    // Beyond the horizon, the antipode included, nothing waits once the wave is done.
    expect(cellReveal(Math.PI, WAVE_COMPLETE_RADIUS, timeline.band)).toBe(1);
    // The sentinel lies beyond any angle plus any band.
    expect(WAVE_COMPLETE_RADIUS).toBeGreaterThan(
      Math.PI * (1 + REVEAL_WAVE_BAND_FRACTION),
    );
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
    const timeline = waveTimeline(1.3);
    const early = waveRadius(timeline, 0.15 * REVEAL_WAVE_MS);
    expect(cellReveal(0, early, timeline.band)).toBe(1);
    expect(cellReveal(1.2, early, timeline.band)).toBe(0);
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
