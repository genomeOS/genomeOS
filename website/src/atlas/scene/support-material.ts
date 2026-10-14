/** Support materials for masked cells (Atlas design §11; Cesium explorer design §8.4).
 *
 * `unknown` cells draw a neutral hatch; `prior_dominated` cells draw dots in
 * their palette-bin colour. Geometry comes from the data worker (spec
 * 2026-10-07 §B.6.5); only the materials live here.
 */

import { Cartesian2, Color, Material } from 'cesium';

import type { Support } from '../contracts';
import { PRIOR_DOTS, UNKNOWN_HATCH } from '../encoding-tokens';

export function materialForSupport(
  support: Extract<Support, 'unknown' | 'prior_dominated'>,
  paletteColor?: string,
): Material {
  if (support === 'unknown') {
    const { alpha, cellAlpha, color, lineCount, lineThickness } = UNKNOWN_HATCH;
    return Material.fromType('Grid', {
      cellAlpha,
      color: Color.fromCssColorString(color).withAlpha(alpha),
      lineCount: new Cartesian2(lineCount, lineCount),
      lineThickness: new Cartesian2(lineThickness, lineThickness),
    });
  }
  if (!paletteColor)
    throw new Error('prior-dominated cells require their palette color');
  const base = Color.fromCssColorString(paletteColor);
  const { darkAlpha, highlightMix, lightAlpha, repeat } = PRIOR_DOTS;
  const highlight = Color.lerp(base, Color.WHITE, highlightMix, new Color());
  return Material.fromType('Dot', {
    darkColor: base.withAlpha(darkAlpha),
    lightColor: highlight.withAlpha(lightAlpha),
    repeat: new Cartesian2(repeat, repeat),
  });
}
