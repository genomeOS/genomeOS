/**
 * The globe's horizon, one rule for what the Earth hides from the camera (Atlas design §11;
 * interaction design §8; terrain draping design, "Goals": symbols and labels are never buried).
 * The hover's hit test (observation-hits.ts) skips a marker behind it, and the country labels
 * (context-overlay.ts) hide a label behind it.
 *
 * A country label skips the depth test within thousands of kilometres of the camera, so that the
 * ground near it never buries it. That distance stood in for the front hemisphere, which it is only
 * for a camera some 3,700 km up or higher: near the ground the horizon is a few hundred kilometres
 * off, and every label between the two was drawn through the Earth (owner report 2026-11-16:
 * Iceland and Greenland over the Atlas Mountains). Cesium culls a collection by its bounding volume
 * only, and the labels' one volume spans the globe, so this test hides each label instead.
 *
 * Only an opaque globe in 3D hides anything. A see-through Earth (opacity under 1) hides nothing:
 * Cesium then culls nothing behind the horizon (Scene.js `getOccluder`) and the globe writes no
 * depth. In 2D and Columbus view every point lies in front of the map, and Cesium keeps a clamped
 * label's position in projected coordinates there.
 *
 * The test is Cesium's own horizon culling against the WGS84 ellipsoid (EllipsoidalOccluder.js),
 * which from a camera below the ellipsoid (the Dead Sea, a deep valley under World Terrain) hides
 * what lies past the plane through the camera, as for one standing on the surface.
 */

import * as Cesium from 'cesium';
import {
  Ellipsoid,
  SceneMode,
  type Cartesian3,
  type Globe,
  type Label,
  type Scene,
} from 'cesium';

/** Cesium's horizon test, typed: its constructor and `cameraPosition` setter are out of its typings. */
export interface HorizonOccluder {
  cameraPosition: Cartesian3;
  isPointVisible(point: Cartesian3): boolean;
}

// Cesium exports its horizon test at runtime but leaves it out of its typings. A member read,
// not a destructuring, so the bundler still keeps only what the scene uses of Cesium.
const EllipsoidalOccluder = (
  Cesium as unknown as {
    EllipsoidalOccluder: new (
      ellipsoid: Ellipsoid,
      camera?: Cartesian3,
    ) => HorizonOccluder;
  }
).EllipsoidalOccluder;

/** A horizon test against WGS84, from `camera` (ECEF metres) when given; reusable by moving it. */
export function horizonOccluder(camera?: Cartesian3): HorizonOccluder {
  return new EllipsoidalOccluder(Ellipsoid.WGS84, camera);
}

/**
 * Whether Cesium draws the globe's front faces see-through (GlobeTranslucencyState.js
 * `isFaceTranslucent`), which `applyEarthOpacity` turns on below opacity 1.
 */
export function seeThrough(
  globe: Pick<Globe, 'baseColor' | 'translucency'>,
): boolean {
  const { baseColor, translucency } = globe;
  if (!translucency.enabled) return false;
  const byDistance = translucency.frontFaceAlphaByDistance;
  const alphas = byDistance ? [byDistance.nearValue, byDistance.farValue] : [1];
  return (
    baseColor.alpha < 1 ||
    alphas.some((alpha) => alpha * translucency.frontFaceAlpha < 1)
  );
}

/** Whether the globe hides what lies beyond its horizon: in 3D, through an opaque globe only. */
export function horizonHides(scene: Pick<Scene, 'globe' | 'mode'>): boolean {
  return scene.mode === SceneMode.SCENE3D && !seeThrough(scene.globe);
}

/** Where Cesium draws `label`: where it clamped it to the ground (Label.js `_clampedPosition`,
 * @private), else its own position. */
export function drawnPosition(label: Pick<Label, 'position'>): Cartesian3 {
  return (
    (label as { _clampedPosition?: Cartesian3 })._clampedPosition ??
    label.position
  );
}

/** Whether the ellipsoid leaves `label` in sight of `occluder`'s camera, where Cesium draws it. */
export function labelAboveHorizon(
  occluder: HorizonOccluder,
  label: Pick<Label, 'position'>,
): boolean {
  return occluder.isPointVisible(drawnPosition(label));
}

/** What one pass of `cullLabels` left hidden, and whether it showed a label it found hidden. */
export interface LabelCull {
  hidden: boolean;
  revealed: boolean;
}

/**
 * Shows each of `labels` that `occluder` sees where Cesium draws it and hides the rest, or with no
 * occluder shows them all. Writes `show` only where it changes: each write rebuilds the
 * collection's glyph buffers.
 */
export function cullLabels(
  labels: readonly Pick<Label, 'position' | 'show'>[],
  occluder: HorizonOccluder | null,
): LabelCull {
  let hidden = false;
  let revealed = false;
  for (const label of labels) {
    const show = !occluder || labelAboveHorizon(occluder, label);
    if (label.show !== show) {
      label.show = show;
      revealed ||= show;
    }
    hidden ||= !show;
  }
  return { hidden, revealed };
}
