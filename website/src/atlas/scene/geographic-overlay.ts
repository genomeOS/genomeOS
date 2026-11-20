/** Country label rules for the Natural Earth context overlay (Atlas design §11; spec 2026-10-07 §B.6.9). */

export {
  countryLabelText,
  type CountryProperties,
} from '../geometry/natural-earth';

const LABEL_CLEARANCE_METRES = 2_500;
/**
 * The farthest a label skips the depth test, so that neither the inferred surface nor the terrain
 * near it buries it. Not what hides the far side of the Earth: it covers only the front hemisphere
 * from a camera some 3,700 km up or higher, and near the ground the horizon is a few hundred
 * kilometres off. The horizon test hides every label behind it (horizon.ts; owner report
 * 2026-11-16).
 */
const LABEL_DEPTH_TEST_SKIP_LIMIT_METRES = 8_000_000;

export function countryLabelHeight(
  surfaceHeight: number,
  elevationFactor: number,
): number {
  return (
    Math.max(0, surfaceHeight) * Math.max(0, elevationFactor) +
    LABEL_CLEARANCE_METRES
  );
}

export function countryLabelDistanceForScale(minLabel: number): number {
  const safeLabel = Number.isFinite(minLabel) ? Math.max(0, minLabel) : 7;
  return Math.max(800_000, 45_000_000 / 2 ** (safeLabel * 0.75));
}

export function countryLabelDepthTestDistance(minLabel: number): number {
  return Math.min(
    countryLabelDistanceForScale(minLabel),
    LABEL_DEPTH_TEST_SKIP_LIMIT_METRES,
  );
}
