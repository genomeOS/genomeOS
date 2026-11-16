/** Stable scene defaults and view policy for Atlas design §11. */

import { Color, type CesiumWidget } from 'cesium';

import { hasPhysicalRelief } from '../earth-style-catalog';
import type { CameraState, LayerVisibility, TerrainId } from '../url-state';
import type { ObservationPresentation } from './types';
import { DEFAULT_OBSERVATION_SIZE_RANGE } from '../observation-encoding';

export { resolveElevationView } from '../earth-style-catalog';

/**
 * The hillshade light that shades physical terrain (#483; terrain draping design, "Per layer
 * under World Terrain"): from the north-west, as on a shaded-relief map, 45° above the horizon at
 * the view target (higher from far out, swinging towards a headlight from 500 km, and faded out
 * beyond 1,000 km: `hillshadeElevationDegrees`, `hillshadeHeadlightWeight`, `hillshadeShading`).
 * Relief is shaded only where the globe is lit, and the real-time sun leaves the night side (or a
 * globe with day/night off) evenly lit and flat, so World Terrain is lit by this fixed light
 * instead, whatever the clock says. Intensity 2 is the value the owner reviewed against the live
 * site's Himalaya and Ethiopian highlands.
 */
export const HILLSHADE_AZIMUTH_DEGREES = 315;
export const HILLSHADE_ELEVATION_DEGREES = 45;
export const HILLSHADE_INTENSITY = 2;
/** How far above the visible disc's edge the light stays when the camera is far out. */
export const HILLSHADE_HORIZON_MARGIN_DEGREES = 10;
const EARTH_RADIUS_METRES = 6_378_137;
const DEGREE = Math.PI / 180;

export interface TerrainLighting {
  enableLighting: boolean;
  light: 'sun' | 'hillshade';
  /**
   * Whether the globe's ground atmosphere and water effect may show. They tint the ground they
   * cover, so under World Terrain they are off while a surface layer shows; the hillshade never
   * turns on one the globe had off (`TerrainShading`).
   */
  groundAtmosphere: boolean;
  waterEffect: boolean;
}

/**
 * The owner's lighting rule (#483; terrain draping design, "Per layer under World Terrain"):
 * World Terrain is always shaded by the fixed hillshade light, with no ground atmosphere or water
 * effect over a shown surface (`surfaceShown`: the surface or support layer is on); the day/night
 * setting applies to the smooth globe, which keeps the real-time sun exactly as before.
 */
export function terrainLighting({
  dayNight,
  surfaceShown,
  terrain,
}: {
  dayNight: boolean;
  surfaceShown: boolean;
  terrain: TerrainId;
}): TerrainLighting {
  return hasPhysicalRelief(terrain)
    ? {
        enableLighting: true,
        groundAtmosphere: !surfaceShown,
        light: 'hillshade',
        waterEffect: !surfaceShown,
      }
    : {
        enableLighting: dayNight,
        groundAtmosphere: true,
        light: 'sun',
        waterEffect: true,
      };
}

/**
 * The light's elevation above the horizon at the view target. 45° wherever relief can be seen.
 * A directional light lights only the hemisphere facing it, so from far out a 45° light would
 * leave a fake night side inside the visible disc; above about 1,410 km, where
 * `acos(R / (R + h)) + 10° = 45°`, the light rises with the horizon, staying
 * `HILLSHADE_HORIZON_MARGIN_DEGREES` above the disc's edge, to overhead.
 */
export function hillshadeElevationDegrees(cameraHeightMetres: number): number {
  const height = Math.max(0, cameraHeightMetres);
  const horizon =
    Math.acos(EARTH_RADIUS_METRES / (EARTH_RADIUS_METRES + height)) / DEGREE;
  return Math.min(
    90,
    Math.max(
      HILLSHADE_ELEVATION_DEGREES,
      horizon + HILLSHADE_HORIZON_MARGIN_DEGREES,
    ),
  );
}

/**
 * Camera heights over which the light swings from the hillshade to a headlight (terrain draping
 * design, "Per layer under World Terrain"): the hillshade up to 500 km, the camera's line of sight
 * from 5,000 km, a linear blend between. From far out a light from one side darkens the limb of
 * the disc; a light along the line of sight lights the whole visible globe evenly.
 */
export const HILLSHADE_HEADLIGHT_METRES = [500_000, 5_000_000] as const;

/** How far the light has swung towards the headlight seen from `heightMetres`, 0 to 1. */
export function hillshadeHeadlightWeight(heightMetres: number): number {
  const [start, end] = HILLSHADE_HEADLIGHT_METRES;
  // A NaN height (a camera mid-morph) counts as far out, like the 2D map's whole-world width.
  if (!(heightMetres < end)) return 1;
  return Math.max(0, (heightMetres - start) / (end - start));
}

/**
 * Heights over which the hillshade fades out (#483 review). A directional light shades the curve
 * of the Earth as well as its relief: ground facing away from it drops to the shadow
 * darkness, with no fade by distance. From far out that is a night side the user cannot switch
 * off, since day/night does not apply to World Terrain; and relief is too small to see from
 * there. So the shading is full up to 1,000 km, fades out by 3,000 km, and World Terrain is drawn
 * unlit beyond, as the smooth globe is with day/night off. In the 2D map Cesium's camera height
 * is the width of the map shown, so the whole-world map is unlit too.
 */
export const HILLSHADE_FADE_METRES = [1_000_000, 3_000_000] as const;
/**
 * `Globe.vertexShadowDarkness` under the hillshade, up to 1,000 km: the brightness kept by ground
 * facing away from the light (Cesium's default is 0.3). With `HILLSHADE_DIFFUSE_MULTIPLIER`, flat
 * ground facing a 45° light keeps the exact legend colour, since Cesium clamps the diffuse term
 * at 1 (GlobeFS.glsl:432): sin 45° × 0.9 + 0.45 ≈ 1.09 (terrain draping design, "Per layer under
 * World Terrain"). Only slopes facing away from the light darken.
 */
export const HILLSHADE_SHADOW_DARKNESS = 0.45;
/**
 * `Globe.lambertDiffuseMultiplier` under the hillshade. It is Cesium 1.145's default
 * (Globe.js:176); the hillshade sets it, and restores the globe's own value, to pin the term the
 * legend-colour rule above relies on.
 */
export const HILLSHADE_DIFFUSE_MULTIPLIER = 0.9;

export interface HillshadeShading {
  enableLighting: boolean;
  /** `Globe.vertexShadowDarkness`; at 1 the light leaves every slope fully bright. */
  shadowDarkness: number;
}

/** How strongly the hillshade shades World Terrain seen from `cameraHeightMetres`. */
export function hillshadeShading(cameraHeightMetres: number): HillshadeShading {
  const [start, end] = HILLSHADE_FADE_METRES;
  // A NaN height (a camera mid-morph) is drawn unlit, like the far view.
  if (!(cameraHeightMetres < end))
    return { enableLighting: false, shadowDarkness: 1 };
  const fade = Math.min(
    1,
    Math.max(0, (cameraHeightMetres - start) / (end - start)),
  );
  return {
    enableLighting: true,
    shadowDarkness:
      HILLSHADE_SHADOW_DARKNESS + fade * (1 - HILLSHADE_SHADOW_DARKNESS),
  };
}

/**
 * The unit direction (Earth-fixed, WGS84) in which a light travels when it shines from
 * `azimuth` (degrees clockwise from north) and `elevation` (degrees above the horizon) at the
 * point `lon`, `lat`: minus the east-north-up vector towards the light.
 */
export function hillshadeDirection(
  lon: number,
  lat: number,
  azimuth: number,
  elevation: number,
): [number, number, number] {
  const [sinLon, cosLon] = [Math.sin(lon * DEGREE), Math.cos(lon * DEGREE)];
  const [sinLat, cosLat] = [Math.sin(lat * DEGREE), Math.cos(lat * DEGREE)];
  const east = Math.sin(azimuth * DEGREE) * Math.cos(elevation * DEGREE);
  const north = Math.cos(azimuth * DEGREE) * Math.cos(elevation * DEGREE);
  const up = Math.sin(elevation * DEGREE);
  return [
    -(-east * sinLon - north * sinLat * cosLon + up * cosLat * cosLon),
    -(east * cosLon - north * sinLat * sinLon + up * cosLat * sinLon),
    -(north * cosLat + up * sinLat),
  ];
}

export interface EarthOpacityTarget {
  depthTestAgainstTerrain: boolean;
  translucency: {
    backFaceAlpha: number;
    enabled: boolean;
    frontFaceAlpha: number;
  };
}

export interface OceanColorTarget {
  baseColor: Color;
}

export function applyOceanColor(globe: OceanColorTarget, color: string): void {
  globe.baseColor = Color.fromCssColorString(color);
}

export function applyEarthOpacity(
  globe: EarthOpacityTarget,
  opacity: number,
): void {
  const safeOpacity = Math.min(1, Math.max(0.15, opacity));
  globe.depthTestAgainstTerrain = true;
  globe.translucency.frontFaceAlpha = safeOpacity;
  globe.translucency.backFaceAlpha = safeOpacity;
  globe.translucency.enabled = safeOpacity < 1;
}

export const DEFAULT_LAYERS: LayerVisibility = {
  context: true,
  countries: true,
  observations: true,
  support: true,
  surface: true,
};

export const DEFAULT_OBSERVATIONS: ObservationPresentation = {
  colorVariable: 'solid',
  gradient: ['#24144b', '#ad8bff', '#f4c86a'],
  opacity: 1,
  samplingAreaColor: '#9af9e2',
  sizeRange: DEFAULT_OBSERVATION_SIZE_RANGE,
  samplingAreas: true,
  shape: 'sphere',
  sizeVariable: 'frequency',
  solidColor: '#f4fbff',
};

export const HOME_CAMERA: CameraState = {
  heading: 0,
  height: 16_500_000,
  lat: 12,
  lon: 20,
  pitch: -90,
};

export function styleAtlasScene(widget: CesiumWidget): void {
  const scene = widget.scene;
  scene.backgroundColor = Color.fromCssColorString('#020712');
  applyOceanColor(scene.globe, '#071b35');
  applyEarthOpacity(scene.globe, 1);
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.00012;
  scene.highDynamicRange = true;
  scene.postProcessStages.fxaa.enabled = true;
  scene.postProcessStages.bloom.enabled = false;
  widget.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
}

/** Defers the sky-box textures until the returned reveal runs: after the map is ready and the
 * post-reveal load order's earlier steps have settled (spec 2026-10-07 §B.6.9). */
export function hideSkyUntilReady(scene: {
  skyBox?: { show: boolean } | undefined;
  requestRender(): void;
}): () => void {
  const skyBox = scene.skyBox;
  if (!skyBox) return () => {};
  skyBox.show = false;
  let revealed = false;
  return () => {
    if (revealed) return;
    revealed = true;
    skyBox.show = true;
    scene.requestRender();
  };
}
