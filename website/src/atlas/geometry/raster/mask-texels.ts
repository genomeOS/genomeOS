/**
 * Grid and Dot texel formulas of the draped support masks (terrain draping design, "Per layer under
 * World Terrain": hatch and dots baked into the surface tiles, #483).
 *
 * `hatchTexel` repeats Cesium 1.145's `Grid` material (GridMaterial.glsl, derivative branch) with
 * the uniforms `scene/support-material.ts` gives it from `UNKNOWN_HATCH`, at a pixel ratio of 1:
 * one texel stands for one pixel, so `stStep`, the st change across one texel, stands for the
 * shader's `dFdx`/`dFdy` maximum. `dotTexel` repeats the `Dot` material (DotMaterial.glsl) with
 * `PRIOR_DOTS`. Grid's rim term, which fades lines towards the limb from the eye vector, has no
 * texel form and is left out.
 *
 * Colours are matched as the globe shows them, not as the materials state them. Imagery shows
 * `czm_gammaCorrect(texel)`, which is texel^γ under HDR. Dot sets only `diffuse` to
 * `czm_gammaCorrect(colour)` and the FLAT mask appearance shows `diffuse + emission`, so a dot texel
 * is the material colour itself. Grid writes `czm_gammaCorrect(0.5 × colour)` into both `diffuse`
 * and `emission`, so the chunk masks show 2 × (0.5 × colour)^γ. The hatch texel is therefore
 * colour × 0.5 × 2^(1/γ), `HATCH_SHADE`, with γ = 2.2 (Cesium's `Scene.gamma`, which Atlas keeps).
 * That holds under HDR, which Atlas requests (`scene-policy.ts`) and Cesium grants wherever float
 * colour buffers exist. Without HDR the chunk hatch shows the full colour, about 1.46 × this
 * texel.
 *
 * The draped surface layer scales its whole texture by `DRAPED_SURFACE_ALPHA`, while the chunk
 * path draws the mask materials unscaled, so each material α is stored divided by it. Bytes are
 * rounded half up, as the tests compute them. Cesium-free: the data worker runs it.
 */

import { PRIOR_DOTS, UNKNOWN_HATCH } from '../../encoding-tokens';
import { DRAPED_SURFACE_ALPHA } from './types';
/** Grid's line blur, in pixels (GridMaterial.glsl `fuzz`). */
const GRID_FUZZ = 1.2;
/** Grid's line half-width beyond one pixel: `lineThickness × czm_pixelRatio − 1`. */
const GRID_THICKNESS = UNKNOWN_HATCH.lineThickness - 1;
/** Dot's edge, as a distance from the dot centre in repeat units (DotMaterial.glsl). */
const DOT_EDGE = [0.3, 0.32] as const;
/** Cesium's display gamma (`Scene.gamma`, the shaders' `czm_gamma`). */
const SCENE_GAMMA = 2.2;
/** Grid's 0.5 × colour, shown twice (diffuse + emission) under HDR, as one imagery texel. */
const HATCH_SHADE = 0.5 * 2 ** (1 / SCENE_GAMMA);

function hexBytes(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

const HATCH_RGB = hexBytes(UNKNOWN_HATCH.color).map(
  (channel) => channel * HATCH_SHADE,
) as [number, number, number];

/** GLSL `smoothstep`; a zero-width edge is a step at `edge0`. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Distance from `coordinate` to the nearest grid line, in line spacings (0 to 0.5). */
function lineDistance(coordinate: number): number {
  const scaled = coordinate - Math.floor(coordinate);
  return Math.abs(scaled - Math.floor(scaled + 0.5));
}

/** The `Grid` hatch of an unknown cell at `st`, written as RGBA bytes at `out[offset]`. */
export function hatchTexel(
  st: readonly [number, number],
  stStep: readonly [number, number],
  out: Uint8ClampedArray,
  offset: number,
): void {
  const { alpha, cellAlpha, lineCount } = UNKNOWN_HATCH;
  let value = 1;
  for (let axis = 0; axis < 2; axis += 1) {
    const dF = stStep[axis] * lineCount;
    value = Math.min(
      value,
      smoothstep(
        dF * GRID_THICKNESS,
        dF * (GRID_FUZZ + GRID_THICKNESS),
        lineDistance(lineCount * st[axis]),
      ),
    );
  }
  out[offset] = Math.round(HATCH_RGB[0]);
  out[offset + 1] = Math.round(HATCH_RGB[1]);
  out[offset + 2] = Math.round(HATCH_RGB[2]);
  out[offset + 3] = Math.round(
    ((alpha * (1 - (1 - cellAlpha) * value)) / DRAPED_SURFACE_ALPHA) * 255,
  );
}

/** The `Dot` pattern of a prior-dominated cell in its bin colour `rgb` (bytes) at `st`, written as
 * RGBA bytes at `out[offset]`. */
export function dotTexel(
  st: readonly [number, number],
  rgb: readonly [number, number, number],
  out: Uint8ClampedArray,
  offset: number,
): void {
  const { darkAlpha, highlightMix, lightAlpha, repeat } = PRIOR_DOTS;
  const ds = repeat * st[0] - Math.floor(repeat * st[0]) - 0.5;
  const dt = repeat * st[1] - Math.floor(repeat * st[1]) - 0.5;
  const b = smoothstep(DOT_EDGE[0], DOT_EDGE[1], Math.sqrt(ds * ds + dt * dt));
  for (let channel = 0; channel < 3; channel += 1) {
    const light = rgb[channel] + (255 - rgb[channel]) * highlightMix;
    out[offset + channel] = Math.round(light * (1 - b) + rgb[channel] * b);
  }
  out[offset + 3] = Math.round(
    ((lightAlpha * (1 - b) + darkAlpha * b) / DRAPED_SURFACE_ALPHA) * 255,
  );
}
