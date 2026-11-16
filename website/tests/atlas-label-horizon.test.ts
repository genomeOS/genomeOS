/**
 * The globe's horizon, which hides a country label beyond it from the camera of an opaque globe
 * (Atlas design §11; terrain draping design, "Goals": symbols and labels are never buried). A
 * label skips the depth test within thousands of kilometres of the camera, so the horizon test is
 * all that keeps the far side of the Earth from drawing over the ground near a low camera (owner
 * report 2026-11-16: Iceland and Greenland over the Atlas Mountains).
 */
import { Cartesian3, Color, NearFarScalar, SceneMode } from 'cesium';
import { describe, expect, it } from 'vitest';

import {
  horizonHides,
  horizonOccluder,
  labelAboveHorizon,
} from '../src/atlas/scene/horizon';

/** Whether a label at `point` is in sight of `camera`, both ECEF metres. */
const seen = (camera: Cartesian3, point: Cartesian3) =>
  labelAboveHorizon(horizonOccluder(camera), { position: point });

/** A country label's clearance over the flat ground (geographic-overlay.ts). */
const LABEL_METRES = 2_500;
/** Kilometres of a degree of latitude, near enough for points hundreds of kilometres apart. */
const KM_PER_DEGREE = 111;

const label = (lon: number, lat: number, height = LABEL_METRES) =>
  Cartesian3.fromDegrees(lon, lat, height);

describe('labelAboveHorizon', () => {
  it('reads a label clamped to the ground where Cesium clamped it', () => {
    const occluder = horizonOccluder(Cartesian3.fromDegrees(-7.5, 31, 3_000));
    const near = label(-7.5, 32);
    const portugal = label(-8, 39.6);
    expect(labelAboveHorizon(occluder, { position: near })).toBe(true);
    expect(
      labelAboveHorizon(occluder, {
        _clampedPosition: portugal,
        position: near,
      } as never),
    ).toBe(false);
  });

  it('moves one occluder from camera to camera', () => {
    const occluder = horizonOccluder();
    const portugal = { position: label(-8, 39.6) };
    occluder.cameraPosition = Cartesian3.fromDegrees(-7.5, 31, 3_000);
    expect(labelAboveHorizon(occluder, portugal)).toBe(false);
    occluder.cameraPosition = Cartesian3.fromDegrees(-7.5, 31, 5_000_000);
    expect(labelAboveHorizon(occluder, portugal)).toBe(true);
  });

  describe('from 3 km over the Atlas Mountains (31° N, 7.5° W)', () => {
    const camera = Cartesian3.fromDegrees(-7.5, 31, 3_000);
    const north = (km: number) => label(-7.5, 31 + km / KM_PER_DEGREE);

    it('sees labels inside the horizon, about 374 km for a label 2,500 m up', () => {
      expect(seen(camera, north(150))).toBe(true);
      expect(seen(camera, north(300))).toBe(true);
    });

    it('hides labels beyond it: 399 km north, Portugal, Iceland and Sweden', () => {
      expect(seen(camera, north(399))).toBe(false);
      expect(seen(camera, label(-8, 39.6))).toBe(false);
      expect(seen(camera, label(-18.6, 64.9))).toBe(false);
      expect(seen(camera, label(15, 62))).toBe(false);
    });

    it('sees a label lifted 200 km above the ground 1,587 km away', () => {
      expect(seen(camera, label(-7.5, 45, 200_000))).toBe(true);
    });
  });

  it('treats a camera below the ellipsoid (400 m under it, at the Dead Sea) as one on the surface', () => {
    const camera = Cartesian3.fromDegrees(35.5, 31.5, -400);
    const north = (km: number) => label(35.5, 31.5 + km / KM_PER_DEGREE);
    expect(seen(camera, north(150))).toBe(true);
    expect(seen(camera, north(190))).toBe(true);
    expect(seen(camera, north(250))).toBe(false);
  });

  it('sees the front hemisphere from 5,000 km straight up, out to about 57° of longitude', () => {
    const camera = Cartesian3.fromDegrees(39.5, 9, 5_000_000);
    for (const offset of [0, 40, 55, 57])
      expect(seen(camera, label(39.5 + offset, 9)), `${offset}°`).toBe(true);
    for (const offset of [60, 140])
      expect(seen(camera, label(39.5 + offset, 9)), `${offset}°`).toBe(false);
  });
});

describe('horizonHides', () => {
  /** A globe as `applyEarthOpacity` leaves it (scene-policy.ts), with an ocean colour of `alpha`. */
  const globe = (opacity = 1, alpha = 1, byDistance?: NearFarScalar) => ({
    baseColor: Color.fromCssColorString('#071b35').withAlpha(alpha),
    translucency: {
      backFaceAlpha: opacity,
      enabled: opacity < 1 || byDistance !== undefined || alpha < 1,
      frontFaceAlpha: opacity,
      frontFaceAlphaByDistance: byDistance,
    },
  });
  const scene = (mode: SceneMode, of = globe()) => ({ globe: of, mode });

  it('holds for an opaque globe in 3D', () => {
    expect(horizonHides(scene(SceneMode.SCENE3D) as never)).toBe(true);
    // Translucency on, every alpha 1: still opaque.
    expect(
      horizonHides(
        scene(SceneMode.SCENE3D, {
          ...globe(),
          translucency: { ...globe().translucency, enabled: true },
        }) as never,
      ),
    ).toBe(true);
  });

  it('does not hold in 2D, Columbus view or a morph, where label positions are projected', () => {
    for (const mode of [
      SceneMode.SCENE2D,
      SceneMode.COLUMBUS_VIEW,
      SceneMode.MORPHING,
    ])
      expect(horizonHides(scene(mode) as never), String(mode)).toBe(false);
  });

  it('does not hold through a see-through Earth, which Cesium culls nothing behind', () => {
    expect(horizonHides(scene(SceneMode.SCENE3D, globe(0.4)) as never)).toBe(
      false,
    );
    expect(horizonHides(scene(SceneMode.SCENE3D, globe(1, 0.5)) as never)).toBe(
      false,
    );
    expect(
      horizonHides(
        scene(
          SceneMode.SCENE3D,
          globe(1, 1, new NearFarScalar(1_000, 1, 10_000_000, 0.4)),
        ) as never,
      ),
    ).toBe(false);
  });
});
