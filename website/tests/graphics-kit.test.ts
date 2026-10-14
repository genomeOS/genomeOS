/**
 * The figure kit's pure modules (site redesign spec §3, #454): Jeffreys intervals, the seeded
 * generator, projections, easing, frame probing, the figure-data round trip, and the marks the
 * canvas and the legend glyphs share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeAreas,
  decodeSurveys,
  encodeAreas,
  encodeSurveys,
  NO_VALUE,
} from '../src/graphics/figure-data';
import { FrameProbe, HexField, contains } from '../src/graphics/hexfield';
import { GLYPH_SYMBOLS } from '../src/components/kit/glyphs';
import {
  ENC,
  PRIOR_LIGHT,
  STUD_RADIUS,
  STUD_RING,
  evidenceColor,
  vsupColor,
} from '../src/graphics/encoding';
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

/**
 * A 2D context that records what each fill and stroke covers (circles only: the stud pass draws
 * arcs), and a point sampler that says which paint ends up on top at a CSS-pixel point.
 */
function recordingCanvas(width: number, height: number) {
  type Paint = {
    kind: 'fill' | 'stroke';
    style: string;
    lineWidth: number;
    alpha: number;
    circles: [number, number, number][];
  };
  const paints: Paint[] = [];
  let circles: Paint['circles'] = [];
  const state: Record<string | symbol, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
  const record = (kind: Paint['kind']) => () =>
    paints.push({
      kind,
      style: String(kind === 'fill' ? state.fillStyle : state.strokeStyle),
      lineWidth: Number(state.lineWidth),
      alpha: Number(state.globalAlpha),
      circles: [...circles],
    });
  const methods: Record<string, (...args: number[]) => unknown> = {
    beginPath: () => {
      circles = [];
    },
    arc: (x, y, r) => {
      circles.push([x, y, r]);
    },
    fill: record('fill'),
    stroke: record('stroke'),
  };
  const ctx = new Proxy(state, {
    get: (target, key) =>
      key in target ? target[key] : (methods[key as string] ?? (() => {})),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  const canvas = {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  /** The paint on top at (x, y), or 'none'. */
  const top = (x: number, y: number): string => {
    let colour = 'none';
    for (const paint of paints) {
      if (paint.alpha <= 0) continue;
      const hit = paint.circles.some(([cx, cy, r]) => {
        const d = Math.hypot(x - cx, y - cy);
        return paint.kind === 'fill'
          ? d <= r
          : Math.abs(d - r) <= paint.lineWidth / 2;
      });
      if (hit) colour = paint.style;
    }
    return colour;
  };
  return { canvas, top, paints };
}

describe('measured studs: a white disc on a 1.5 px void ring, like the poster and the glyph (spec §2.2, §2.6)', () => {
  const VOID = '#020712';
  const CENTRE: [number, number] = [100, 100];
  const survey = (lon: number, an: number) => ({
    lat: 0,
    lon,
    ac: 0,
    an,
    radiusKm: 10,
  });
  /** The longitude that lands `px` CSS pixels east of the centre on a 100 px globe. */
  const east = (px: number) => (Math.asin(px / 100) * 180) / Math.PI;
  const draw = (surveys: ReturnType<typeof survey>[]) => {
    const { canvas, top } = recordingCanvas(200, 200);
    new HexField(canvas, {
      areas: [],
      surveys,
      projection: orthographic({
        center: [0, 0],
        scale: 100,
        translate: CENTRE,
      }),
      fit: (_width, _height, projection) => {
        projection.scale = 100;
        projection.translate = CENTRE;
      },
      domain: [0, 0.2],
    });
    return (dx: number, dy = 0) => top(CENTRE[0] + dx, CENTRE[1] + dy);
  };
  const angles = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);

  beforeEach(() => {
    // The hatch pattern needs a scratch canvas; these tests draw no hatched area.
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null }),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws one stud as a white disc of its radius, then 1.5 px of void ring', () => {
    expect(STUD_RING).toBe(1.5);
    const at = draw([survey(0, 500)]);
    const r = STUD_RADIUS.md;
    for (const angle of angles) {
      const point = (d: number) => at(d * Math.cos(angle), d * Math.sin(angle));
      for (const d of [0, 1, r - 0.6, r - 0.05])
        expect(point(d), `${d} px`).toBe(ENC.obs);
      for (const d of [r + 0.05, r + 0.75, r + STUD_RING - 0.05])
        expect(point(d), `${d} px`).toBe(VOID);
      expect(point(r + STUD_RING + 0.05)).toBe('none');
    }
  });

  it('shows surveys at one place as the largest white stud, never a dark disc with a dot', () => {
    // Three surveys share a coordinate (93 places do in the committed data): the best-sampled one
    // must read as a whole white stud (design review, fix round 2).
    const at = draw([survey(0, 50), survey(0, 500), survey(0, 5000)]);
    const r = STUD_RADIUS.lg;
    for (const angle of angles)
      for (let d = 0; d <= r - 0.05; d += 0.25)
        expect(
          at(d * Math.cos(angle), d * Math.sin(angle)),
          `${d.toFixed(2)} px from the shared place`,
        ).toBe(ENC.obs);
    expect(at(r + 0.75)).toBe(VOID);
  });

  it('lets studs of one size merge instead of ringing each other', () => {
    // Two 200–1,999-allele surveys 4 px apart: one white mark inside one ring, as on the poster.
    const at = draw([survey(0, 500), survey(east(4), 600)]);
    const r = STUD_RADIUS.md;
    for (let x = -r + 0.05; x <= 4 + r - 0.05; x += 0.25)
      expect(at(x), `${x.toFixed(2)} px`).toBe(ENC.obs);
  });

  it('paints a bigger stud over a smaller neighbour, both still white', () => {
    // Small to large, as the poster draws them: the large stud's ring cuts the small one, never
    // the other way round.
    const at = draw([survey(0, 5000), survey(east(5), 50)]);
    expect(at(0)).toBe(ENC.obs);
    expect(at(5 + STUD_RADIUS.sm - 0.2)).toBe(ENC.obs);
    expect(at(STUD_RADIUS.lg - 0.2)).toBe(ENC.obs);
  });

  it.each(['sm', 'md', 'lg'] as const)(
    'the legend glyph stud-%s is the same mark',
    (size) => {
      const circles = [
        ...GLYPH_SYMBOLS[`stud-${size}`].matchAll(/<circle([^>]*)\/>/g),
      ].map(([, attributes]) => ({
        r: Number(attributes.match(/\br="([^"]+)"/)?.[1]),
        fill: attributes.match(/\bfill="([^"]+)"/)?.[1],
        stroke: attributes.match(/\bstroke="([^"]+)"/)?.[1],
      }));
      expect(circles).toEqual([
        {
          r: STUD_RADIUS[size] + STUD_RING,
          fill: 'var(--enc-obs-ring)',
          stroke: undefined,
        },
        { r: STUD_RADIUS[size], fill: 'var(--enc-obs)', stroke: undefined },
      ]);
    },
  );
});

describe('mostly-prior dots follow the layer, and the Measured layer draws none (spec §2.2, §4.1)', () => {
  const DOMAIN = [0, 0.2] as const;
  const area = {
    boundary: [
      [-4, 0],
      [-2, 3.5],
      [2, 3.5],
      [4, 0],
      [2, -3.5],
      [-2, -3.5],
    ] as [number, number][],
    center: [0, 0] as [number, number],
    mean: 0.1,
    lo: 0.05,
    hi: 0.16,
    distanceKm: 300,
    support: 'prior_dominated' as const,
    tier: 'partial' as const,
  };
  const paintsOn = (layer: 'measured' | 'modeled' | 'evidence') => {
    const { canvas, paints } = recordingCanvas(200, 200);
    new HexField(canvas, {
      areas: [area],
      surveys: [],
      layer,
      projection: orthographic({
        center: [0, 0],
        scale: 100,
        translate: [100, 100],
      }),
      fit: (_width, _height, projection) => {
        projection.scale = 100;
        projection.translate = [100, 100];
      },
      domain: DOMAIN,
    });
    return new Set(
      paints.filter((paint) => paint.alpha > 0).map((paint) => paint.style),
    );
  };
  const modeled = vsupColor(area.mean, 'partial', DOMAIN)!;
  const evidence = evidenceColor('partial')!;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null }),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dots a Modeled cell in its VSUP colour', () => {
    const styles = paintsOn('modeled');
    expect(styles).toContain(modeled);
    expect(styles).toContain(PRIOR_LIGHT[modeled]);
  });

  it('dots an Evidence cell in its evidence colour, never its modeled value', () => {
    const styles = paintsOn('evidence');
    expect(styles).toContain(evidence);
    expect(styles).toContain(PRIOR_LIGHT[evidence]);
    expect(styles).not.toContain(modeled);
    expect(styles).not.toContain(PRIOR_LIGHT[modeled]);
  });

  it('draws only the footprint on Measured: no modeled value and no dots', () => {
    const styles = paintsOn('measured');
    expect(styles).toContain(ENC.land);
    for (const colour of [modeled, evidence, ...Object.values(PRIOR_LIGHT)])
      expect(styles).not.toContain(colour);
  });
});
