/**
 * The figure kit's pure modules (site redesign spec §3, #454): Jeffreys intervals, the seeded
 * generator, projections, easing, frame probing, and the figure-data round trip.
 */
import { describe, expect, it } from 'vitest';

import {
  decodeAreas,
  decodeSurveys,
  encodeAreas,
  encodeSurveys,
  NO_VALUE,
} from '../src/graphics/figure-data';
import { FrameProbe, contains } from '../src/graphics/hexfield';
import { GLYPH_SYMBOLS } from '../src/components/kit/glyphs';
import { ENC } from '../src/graphics/encoding';
import { jeffreys } from '../src/graphics/jeffreys';
import {
  fitEqualArea,
  haversineKm,
  lambertAzimuthal,
  orthographic,
} from '../src/graphics/projection';
import { SEED, jitter, mulberry32 } from '../src/graphics/rng';
import { cubicBezier, easeCamera, tween } from '../src/graphics/tween';

describe('Jeffreys 95% intervals (tools-final/jeffreys.py)', () => {
  it.each([
    [0, 20, 0, 11.664],
    [0, 50, 0, 4.876],
    [0, 100, 0, 2.475],
    [0, 200, 0, 1.247],
    [0, 500, 0, 0.501],
    [0, 1000, 0, 0.251],
    [0, 2000, 0, 0.126],
    [61, 412, 11.627, 18.477],
    [3, 20, 4.413, 34.858],
    [300, 2000, 13.486, 16.615],
  ])('%i of %i: %f%% to %f%%', (ac, an, lo, hi) => {
    const interval = jeffreys(ac, an);
    expect(interval.lo * 100).toBeCloseTo(lo, 2);
    expect(interval.hi * 100).toBeCloseTo(hi, 2);
    expect(interval.mean).toBeCloseTo((ac + 0.5) / (an + 1), 12);
  });

  it('reads zero as weak evidence, never absence', () => {
    expect(jeffreys(0, 20).hi).toBeGreaterThan(0.1);
    expect(jeffreys(20, 20).hi).toBe(1);
  });

  it('refuses counts that are not counts', () => {
    expect(() => jeffreys(1.5, 20)).toThrow();
    expect(() => jeffreys(21, 20)).toThrow();
    expect(() => jeffreys(0, 0)).toThrow();
  });
});

describe('seeded randomness', () => {
  it('uses SEED = 42 and repeats exactly', () => {
    expect(SEED).toBe(42);
    const a = mulberry32();
    const b = mulberry32(42);
    const first = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(jitter(4, 2)).toEqual(jitter(4, 2));
  });
});

describe('projections', () => {
  it('puts the orthographic centre at the translate point and hides the far side', () => {
    const globe = orthographic({
      center: [18, 8],
      scale: 300,
      translate: [320, 320],
    });
    const [x, y, cosc] = globe.project(18, 8);
    expect([x, y]).toEqual([320, 320]);
    expect(cosc).toBeCloseTo(1, 12);
    expect(globe.project(-162, -8)[2]).toBeLessThan(0);
  });

  it.each([
    ['orthographic', orthographic],
    ['equal-area', lambertAzimuthal],
  ] as const)('%s inverts what it projects', (_name, make) => {
    const projection = make({
      center: [35, 10],
      scale: 250,
      translate: [400, 300],
    });
    for (const [lon, lat] of [
      [35, 10],
      [8, 9],
      [70, 30],
      [20, -30],
    ]) {
      const [x, y] = projection.project(lon, lat);
      const [ilon, ilat] = projection.invert(x, y)!;
      expect(ilon).toBeCloseTo(lon, 6);
      expect(ilat).toBeCloseTo(lat, 6);
    }
    expect(projection.invert(400 + 600, 300)).toBeNull();
  });

  it('keeps equal areas equal', () => {
    // Two 10° × 10° boxes at the same latitude band, one near and one far from the centre.
    const projection = lambertAzimuthal({
      center: [35, 10],
      scale: 1,
      translate: [0, 0],
    });
    const area = (lon: number) => {
      const corners = [
        [lon, 0],
        [lon + 10, 0],
        [lon + 10, 10],
        [lon, 10],
      ].map(([a, b]) => projection.project(a, b));
      let twice = 0;
      corners.forEach(([x1, y1], index) => {
        const [x2, y2] = corners[(index + 1) % corners.length];
        twice += x1 * y2 - x2 * y1;
      });
      return Math.abs(twice) / 2;
    };
    expect(area(30) / area(80)).toBeCloseTo(1, 1);
  });

  it('fits a window into a box', () => {
    const window = [
      [-26, -37],
      [98, -37],
      [98, 46],
      [-26, 46],
    ] as const;
    const fitted = fitEqualArea([35, 10], window, 800, 600, 10);
    for (const [lon, lat] of window) {
      const [x, y] = fitted.project(lon, lat);
      expect(x).toBeGreaterThanOrEqual(9.9);
      expect(x).toBeLessThanOrEqual(790.1);
      expect(y).toBeGreaterThanOrEqual(9.9);
      expect(y).toBeLessThanOrEqual(590.1);
    }
  });

  it('measures great-circle distance', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 1);
  });
});

describe('easing and tweens', () => {
  it('matches the CSS curves at their ends and middle', () => {
    expect(easeCamera(0)).toBe(0);
    expect(easeCamera(1)).toBe(1);
    expect(easeCamera(0.5)).toBeCloseTo(0.5, 3);
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
  });

  it('stops scheduling once it reaches 1', async () => {
    let now = 0;
    const queue: FrameRequestCallback[] = [];
    const schedule = (callback: FrameRequestCallback) => queue.push(callback);
    const seen: number[] = [];
    const run = tween(
      100,
      (value) => seen.push(value),
      (t) => t,
      schedule,
    );
    while (queue.length) {
      now += 40;
      queue.shift()!(now);
    }
    await run.done;
    expect(seen.at(-1)).toBe(1);
    expect(queue).toHaveLength(0);
  });
});

describe('frame probe and hit tests', () => {
  it('reports the median of the last ten frames', () => {
    const probe = new FrameProbe();
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]) probe.record(ms);
    expect(probe.full).toBe(true);
    expect(probe.median()).toBe(6.5);
  });

  it('finds a point inside a ring', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(contains(square, 5, 5)).toBe(true);
    expect(contains(square, 15, 5)).toBe(false);
  });
});

describe('figure data round trip', () => {
  it('keeps counts as counts and intervals honest after quantisation', () => {
    const surveys = [
      { lat: 9.06, lon: 7.49, ac: 657, an: 3724, radiusKm: 2 },
      { lat: -33.92, lon: 151.2, ac: 0, an: 20, radiusKm: 13 },
    ];
    expect(decodeSurveys(encodeSurveys(surveys))).toEqual(surveys);
    expect(() => encodeSurveys([{ ...surveys[0], ac: 4000 }])).toThrow();

    const ring: [number, number][] = [
      [10, 0],
      [11, 0.5],
      [11, 1.5],
      [10, 2],
      [9, 1.5],
      [9, 0.5],
    ];
    const [area, unknown] = decodeAreas(
      encodeAreas([
        {
          boundary: ring,
          mean: 0.123456,
          lo: 0.100004,
          hi: 0.150001,
          distanceKm: 120.4,
          support: 'interpolated',
          tier: 'strong',
        },
        {
          boundary: ring.slice(0, 5),
          mean: 0.01,
          lo: 0.005,
          hi: 0.02,
          distanceKm: 2000,
          support: 'unknown',
          tier: 'none',
        },
      ]),
    );
    expect(area.mean).toBe(0.1235);
    expect(area.lo).toBe(0.1);
    expect(area.hi).toBe(0.1501);
    expect(area.distanceKm).toBe(120);
    expect(area.center[0]).toBeCloseTo(10, 0);
    expect(unknown.mean).toBeNull();
    expect(unknown.lo).toBeNull();
    expect(unknown.hi).toBeNull();
    expect(unknown.boundary).toHaveLength(6);
    expect(NO_VALUE).toBe(0xffff);
  });
});

describe("the legend hatch glyph is the figures' hatch (spec §2.2, §2.6)", () => {
  const svg = GLYPH_SYMBOLS.hatch;
  const strokes = svg.match(/<path clip-path="[^"]+" d="([^"]+)"[^>]*>/)!;
  const segments = [
    ...strokes[1].matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g),
  ].map((match) => match.slice(1).map(Number));

  it('draws 45° strokes 1.4 units wide', () => {
    expect(strokes[0]).toContain(`stroke-width="${ENC.hatchWidth}"`);
    expect(segments.length).toBeGreaterThan(2);
    // Lines x + y = c run bottom-left to top-right, like the canvas and the poster.
    for (const [x1, y1, x2, y2] of segments) {
      expect(x1 + y1).toBeCloseTo(x2 + y2, 6);
      expect(x1).not.toBe(x2);
    }
  });

  it('spaces them 5 units apart and covers the whole hexagon', () => {
    const offsets = segments.map(([x, y]) => x + y).sort((a, b) => a - b);
    for (let index = 1; index < offsets.length; index += 1)
      expect((offsets[index] - offsets[index - 1]) / Math.SQRT2).toBeCloseTo(
        ENC.hatchPitch,
        2,
      );
    // The 18-unit hexagon (centre 9, 9; radius 8) spans x + y from about 7.1 to 28.9.
    expect(offsets[0]).toBeLessThanOrEqual(7.1);
    expect(offsets.at(-1)).toBeGreaterThanOrEqual(28.9);
  });
});
