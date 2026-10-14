/** The Atlas's visual words in one place (site redesign spec §2.2, #454; Atlas design §11).
 *
 * `visual-encoding.ts` (palettes), `observation-encoding.ts` (the stud colour) and
 * `scene/support-material.ts` (the `unknown` hatch and `prior_dominated` dots) read their
 * constants from here, and `src/graphics/encoding.ts` derives the marketing site's figure tokens
 * from the same values, so a site figure cannot drift from the product it illustrates.
 *
 * Cesium-free and DOM-free: the site bundles it without the globe.
 */

/** Surface palettes, as sRGB stops interpolated in linear light (`visual-encoding.ts`). */
export const ATLAS_PALETTES = {
  cividis: ['#00204c', '#7d7c78', '#fee838'],
  genome: ['#10213e', '#27a9d0', '#72e7c1'],
  golden: ['#241133', '#7a3f18', '#d49425', '#f4c86a', '#fff3bd'],
  plasma: ['#0d0887', '#cc4778', '#f0f921'],
  rainbow: ['#6e40aa', '#417de0', '#1ac7c2', '#7bd34d', '#f2cf44', '#ff5e63'],
  signal: ['#24144b', '#ad8bff', '#f4c86a'],
  viridis: ['#440154', '#21918c', '#fde725'],
} as const;

/** A measured observation's default solid colour: the white stud. */
export const OBSERVATION_SOLID = '#f4fbff';

/** `unknown` support: a neutral hatch (Cesium `Grid` material), no number. */
export const UNKNOWN_HATCH = {
  color: '#a8b5c9',
  alpha: 0.72,
  cellAlpha: 0.24,
  lineCount: 5,
  lineThickness: 1.65,
} as const;

/** `prior_dominated` support: dots in the cell's palette colour (Cesium `Dot` material). */
export const PRIOR_DOTS = {
  /** The light dot is the palette colour mixed this far toward white. */
  highlightMix: 0.38,
  darkAlpha: 0.46,
  lightAlpha: 0.82,
  repeat: 10,
} as const;
