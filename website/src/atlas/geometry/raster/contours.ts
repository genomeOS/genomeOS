/**
 * Honmoon contour shading for draped surface texels (terrain draping design, "Per layer under World
 * Terrain": "honmoon contours from an analytic gradient", and "Build phases" item 4, #483).
 *
 * A port of the smooth-globe Honmoon fragment in `scene/surface-appearance.ts`, one texel at a
 * time. The shader's `fwidth(contourCoordinate)` becomes the band count times the value's change
 * over one texel step (`|∂v/∂column| + |∂v/∂row|`), which the rasteriser takes from the fan
 * triangle's exact gradient that `triangle-scan.ts` hands each texel (a central difference at a
 * pole). `triangleValueGradient` is the same plane's gradient per degree, the independent
 * reference the tests check the scan's against; no rasteriser calls it. Material alpha is 1, since
 * the imagery layer's alpha carries the opacity. The shader's `luminous × 1.35` overshoot, which
 * high dynamic range keeps on the smooth globe, saturates at 255 here. Contours read only the
 * normalised value, never terrain height. Cesium-free: it runs in the data worker, loaded only
 * through `import()`.
 */

import { HONMOON_CONTOUR_BANDS } from '../surface-buffers';

/** 1: lines (`honmoon`); 2: lines and fill (`honmoon-fill`). */
export type HonmoonMode = 1 | 2;

/** The shader's `clamp(fwidth(contourCoordinate), 0.006, 0.22)`. */
export const HONMOON_DERIVATIVE_CLAMP = [0.006, 0.22] as const;

const [MIN_DERIVATIVE, MAX_DERIVATIVE] = HONMOON_DERIVATIVE_CLAMP;
// smoothstep edges of the line's core and halo, in line widths from the contour.
const CORE_EDGES = [0.45, 1.15] as const;
const HALO_EDGES = [0.7, 4.5] as const;
const FILL_ALPHA = 0.28;
const FILL_SHADE = 0.55;
const HALO_ALPHA = 0.42;
const HALO_GLOW = 0.62;
const LUMINOUS_GAIN = 1.35;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** [∂v/∂lon, ∂v/∂lat] per degree of the plane through three vertices; [0, 0] when collinear. */
export function triangleValueGradient(
  lon0: number,
  lat0: number,
  v0: number,
  lon1: number,
  lat1: number,
  v1: number,
  lon2: number,
  lat2: number,
  v2: number,
  out: Float64Array = new Float64Array(2),
): Float64Array {
  const dx1 = lon1 - lon0;
  const dy1 = lat1 - lat0;
  const dv1 = v1 - v0;
  const dx2 = lon2 - lon0;
  const dy2 = lat2 - lat0;
  const dv2 = v2 - v0;
  const det = dx1 * dy2 - dx2 * dy1;
  if (det === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  out[0] = (dv1 * dy2 - dv2 * dy1) / det;
  out[1] = (dx1 * dv2 - dx2 * dv1) / det;
  return out;
}

/** One texel's RGBA at out[offset..offset+3]. colour: interpolated sRGB in [0, 1] (v_surfaceColor); value: the normalised
 * value (v_surfaceValue); valueDerivative: |∂v/∂column| + |∂v/∂row| per texel. */
export function honmoonTexel(
  colour: ArrayLike<number>,
  value: number,
  valueDerivative: number,
  mode: HonmoonMode,
  out: Uint8ClampedArray,
  offset: number,
): void {
  const width = HONMOON_CONTOUR_BANDS * valueDerivative;
  // A degenerate or non-finite gradient (a sliver or polar fan) draws the widest line.
  const derivative = Number.isFinite(width)
    ? Math.min(MAX_DERIVATIVE, Math.max(MIN_DERIVATIVE, width))
    : MAX_DERIVATIVE;
  const contourCoordinate = value * HONMOON_CONTOUR_BANDS;
  const shifted = contourCoordinate + 0.5;
  const distanceToLine = Math.abs(shifted - Math.floor(shifted) - 0.5);
  const fillAlpha = mode === 2 ? FILL_ALPHA : 0;
  const pixelsFromLine = distanceToLine / derivative;
  if (pixelsFromLine >= HALO_EDGES[1]) {
    // Beyond the halo core and halo are 0: the formula's own fill, at no smoothstep's cost.
    out[offset] = 255 * FILL_SHADE * colour[0];
    out[offset + 1] = 255 * FILL_SHADE * colour[1];
    out[offset + 2] = 255 * FILL_SHADE * colour[2];
    out[offset + 3] = 255 * fillAlpha;
    return;
  }
  const core = 1 - smoothstep(CORE_EDGES[0], CORE_EDGES[1], pixelsFromLine);
  const halo = 1 - smoothstep(HALO_EDGES[0], HALO_EDGES[1], pixelsFromLine);
  const towardsWhite = 0.2 + core * 0.3;
  const glow = Math.max(core, halo * HALO_GLOW);
  for (let channel = 0; channel < 3; channel += 1) {
    const c = colour[channel];
    const fill = c * FILL_SHADE;
    const luminous = (c + (1 - c) * towardsWhite) * LUMINOUS_GAIN;
    out[offset + channel] = 255 * (fill + (luminous - fill) * glow);
  }
  out[offset + 3] = 255 * Math.max(fillAlpha, core, halo * HALO_ALPHA);
}
