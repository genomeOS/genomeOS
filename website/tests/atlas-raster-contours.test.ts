import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HONMOON_DERIVATIVE_CLAMP,
  honmoonTexel,
  triangleValueGradient,
} from '../src/atlas/geometry/raster/contours';
import {
  HONMOON_CONTOUR_BANDS,
  honmoonModeForGeometry,
} from '../src/atlas/geometry/surface-buffers';

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** surface-appearance.ts's Honmoon fragment with material.alpha 1 and fwidth(contourCoordinate) = 36 × derivative. */
function shaderHonmoon(
  c: readonly number[],
  v: number,
  derivative: number,
  mode: 1 | 2,
): number[] {
  const cc = v * 36;
  const d = Math.abs(cc + 0.5 - Math.floor(cc + 0.5) - 0.5);
  const p = d / Math.min(0.22, Math.max(0.006, 36 * derivative));
  const core = 1 - smoothstep(0.45, 1.15, p);
  const halo = 1 - smoothstep(0.7, 4.5, p);
  const rgb = c.map((x) =>
    mix(
      x * 0.55,
      mix(x, 1, 0.2 + core * 0.3) * 1.35,
      Math.max(core, halo * 0.62),
    ),
  );
  const alpha = Math.max(mode === 2 ? 0.28 : 0, Math.max(core, halo * 0.42));
  return [...rgb, alpha].map((x) =>
    Math.round(255 * Math.min(1, Math.max(0, x))),
  );
}
const texel = (
  c: readonly number[],
  v: number,
  derivative: number,
  mode: 1 | 2,
) => {
  const out = new Uint8ClampedArray(4);
  honmoonTexel(c, v, derivative, mode, out, 0);
  return [...out];
};

describe('Honmoon contour texels (#483)', () => {
  it('ports the smooth-globe Honmoon fragment within one byte', () => {
    for (const mode of [1, 2] as const)
      for (const c of [
        [0, 0, 0],
        [0.2, 0.6, 0.9],
        [1, 1, 1],
        [0.93, 0.11, 0.42],
      ])
        for (const v of [0, 1 / 72, 0.1, 0.5, 37 / 72, 0.9861, 1])
          for (const derivative of [0, 1e-5, 0.0002, 0.003, 0.05, 1])
            texel(c, v, derivative, mode).forEach((byte, channel) =>
              expect(
                Math.abs(byte - shaderHonmoon(c, v, derivative, mode)[channel]),
              ).toBeLessThanOrEqual(1),
            );
  });

  it('draws one contour per band a ramp crosses', () => {
    for (const mode of [1, 2] as const) {
      const lit = Array.from(
        { length: 256 },
        (_, col) =>
          texel([0.2, 0.6, 0.9], 0.1 + (0.8 * col) / 255, 0.8 / 255, mode)[3] >=
          128,
      );
      // lines at k/36 for k = 4..32
      expect(lit.filter((on, col) => on && !lit[col - 1]).length).toBe(29);
    }
  });

  it('draws a degenerate or non-finite derivative as the widest line, never NaN bytes', () => {
    expect(texel([0.2, 0.6, 0.9], 0.51, Number.NaN, 1)).toEqual(
      texel([0.2, 0.6, 0.9], 0.51, Number.POSITIVE_INFINITY, 1),
    );
    // 36 × 1 clamps to 0.22
    expect(texel([0.2, 0.6, 0.9], 0.51, Number.NaN, 1)).toEqual(
      texel([0.2, 0.6, 0.9], 0.51, 1, 1),
    );
  });

  it('writes only its own four bytes', () => {
    const out = new Uint8ClampedArray(12).fill(7);
    honmoonTexel([0.2, 0.6, 0.9], 0.5, 0.003, 2, out, 4);
    expect([...out.subarray(0, 4), ...out.subarray(8)]).toEqual(
      Array(8).fill(7),
    );
    expect([...out.subarray(4, 8)]).toEqual(
      texel([0.2, 0.6, 0.9], 0.5, 0.003, 2),
    );
  });

  it("clamps the derivative to the shader's fwidth range", () => {
    expect(HONMOON_DERIVATIVE_CLAMP).toEqual([0.006, 0.22]);
  });

  it('gives the plane through three vertices, and none for collinear ones', () => {
    const plane = (lon: number, lat: number) => 0.01 * lon + 0.02 * lat;
    const g = triangleValueGradient(
      36,
      -2,
      plane(36, -2),
      37,
      -2,
      plane(37, -2),
      36.5,
      -1,
      plane(36.5, -1),
    );
    expect(g[0]).toBeCloseTo(0.01, 12);
    expect(g[1]).toBeCloseTo(0.02, 12);
    expect([...triangleValueGradient(0, 0, 0, 1, 1, 0.5, 2, 2, 1)]).toEqual([
      0, 0,
    ]);
  });

  it('writes the gradient into the array it is given', () => {
    const out = new Float64Array([9, 9]);
    expect(triangleValueGradient(0, 0, 0, 1, 0, 0.5, 0, 1, 0.25, out)).toBe(
      out,
    );
    expect([...out]).toEqual([0.5, 0.25]);
    expect([
      ...triangleValueGradient(0, 0, 0, 1, 1, 0.5, 2, 2, 1, out),
    ]).toEqual([0, 0]);
  });

  it('still ports the shader text it was written from', () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../src/atlas/scene/surface-appearance.ts',
      ),
      'utf8',
    );
    for (const line of [
      'float distanceToLine = abs(fract(contourCoordinate + 0.5) - 0.5);',
      'float screenDerivative = clamp(fwidth(contourCoordinate), 0.006, 0.22);',
      'float core = 1.0 - smoothstep(0.45, 1.15, pixelsFromLine);',
      'float halo = 1.0 - smoothstep(0.7, 4.5, pixelsFromLine);',
      'vec3 luminous = mix(v_surfaceColor, vec3(1.0), 0.2 + core * 0.3);',
      'float fillAlpha = u_honmoonMode > 1.5 ? material.alpha * 0.28 : 0.0;',
      'float lineAlpha = material.alpha * max(core, halo * 0.42);',
      'vec3 fillColor = v_surfaceColor * 0.55;',
      'mix(fillColor, luminous * 1.35, max(core, halo * 0.62)),',
    ])
      expect(source).toContain(line);
  });

  it("shares the smooth globe's band count and mode table", async () => {
    const scene = await import('../src/atlas/scene/surface-appearance');
    expect(scene.HONMOON_CONTOUR_BANDS).toBe(HONMOON_CONTOUR_BANDS);
    expect(HONMOON_CONTOUR_BANDS).toBe(36);
    expect(scene.honmoonModeForGeometry).toBe(honmoonModeForGeometry);
  });
});
