/** Stable scene defaults and view policy for Atlas design §11. */

import { Color, type CesiumWidget } from 'cesium';

import { hasPhysicalRelief } from '../earth-style-catalog';
import type { CameraState, LayerVisibility, TerrainId } from '../url-state';
import type { ObservationPresentation } from './types';
import { DEFAULT_OBSERVATION_SIZE_RANGE } from '../observation-encoding';

export { resolveElevationView } from '../earth-style-catalog';

/**
 * The hillshade light that shades physical terrain (#483): from the north-west, as on a shaded-
 * relief map, 35° above the horizon at the view target. Relief is shaded only where the globe is
 * lit, and the real-time sun leaves the night side (or a globe with day/night off) evenly lit and
 * flat, so World Terrain is lit by this fixed light instead, whatever the clock says. Intensity
 * 2 is the value the owner reviewed against the live site's Himalaya and Ethiopian highlands.
 */
export const HILLSHADE_AZIMUTH_DEGREES = 315;
export const HILLSHADE_ELEVATION_DEGREES = 35;
export const HILLSHADE_INTENSITY = 2;
/** How far above the visible disc's edge the light stays when the camera is far out. */
export const HILLSHADE_HORIZON_MARGIN_DEGREES = 10;
const EARTH_RADIUS_METRES = 6_378_137;
const DEGREE = Math.PI / 180;

export interface TerrainLighting {
  enableLighting: boolean;
  light: 'sun' | 'hillshade';
}

/**
 * The owner's lighting rule (#483): World Terrain is always shaded by the fixed hillshade light;
 * the day/night setting applies to the smooth globe, which keeps the real-time sun exactly as
 * before.
 */
export function terrainLighting({
  dayNight,
  terrain,
}: {
  dayNight: boolean;
  terrain: TerrainId;
}): TerrainLighting {
  return hasPhysicalRelief(terrain)
    ? { enableLighting: true, light: 'hillshade' }
    : { enableLighting: dayNight, light: 'sun' };
}

/**
 * The light's elevation above the horizon at the view target. 35° wherever relief can be seen.
 * A directional light lights only the hemisphere facing it, so from far out a 35° light would
 * leave a fake night side inside the visible disc; above about 660 km the light rises with the
 * horizon, staying `HILLSHADE_HORIZON_MARGIN_DEGREES` above the disc's edge, to overhead.
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
