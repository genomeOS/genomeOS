/**
 * Test-only physical terrain for the e2e build (Atlas design §11; terrain draping design,
 * "Test plan"; #483). CI has no Cesium ion token, so World Terrain cannot load there; a browser
 * test that sets `window.__atlasSyntheticTerrain` gets this terrain of known height in its place
 * (`syntheticTerrainTestHook`, e2e-hooks.ts): a cone under Everest, and a Gaussian peak under the
 * HbS Spain survey, where the e2e fixture supports every nearby cell, so data drapes over relief.
 * The test reads the scene through `window.__atlasTerrainProbe`. Only the e2e build loads this
 * module: the hook imports it dynamically behind `PUBLIC_ATLAS_E2E_HOOKS`, so no production chunk
 * carries it.
 */

import {
  Cartesian3,
  Cartographic,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  Math as CesiumMath,
  SceneTransforms,
  SunLight,
  type CesiumWidget,
} from 'cesium';

import {
  SYNTHETIC_CONE,
  SYNTHETIC_PEAK,
  type TerrainProbe,
} from '../e2e-hooks';

export { SYNTHETIC_CONE, SYNTHETIC_PEAK } from '../e2e-hooks';

const EARTH_RADIUS_KM = 6_371;
const TILE_SAMPLES = 33;

/** Great-circle distance (km) from `from` to (`lon`, `lat`), all in degrees. */
function distanceKm(
  from: { lat: number; lon: number },
  lon: number,
  lat: number,
): number {
  const φ1 = CesiumMath.toRadians(from.lat);
  const φ2 = CesiumMath.toRadians(lat);
  const Δλ = CesiumMath.toRadians(lon - from.lon);
  const cosine =
    Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return EARTH_RADIUS_KM * Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/** The cone's height (metres) at a point, by great-circle distance from its apex. */
export function syntheticConeHeight(lon: number, lat: number): number {
  return (
    SYNTHETIC_CONE.peakMetres *
    Math.max(
      0,
      1 - distanceKm(SYNTHETIC_CONE, lon, lat) / SYNTHETIC_CONE.radiusKm,
    )
  );
}

/**
 * The synthetic terrain's height (metres) at a point: the cone plus the Gaussian peak,
 * `peakMetres · exp(−d² / 2σ²)` by great-circle distance `d` from its apex.
 */
export function syntheticTerrainHeight(lon: number, lat: number): number {
  const d = distanceKm(SYNTHETIC_PEAK, lon, lat);
  return (
    syntheticConeHeight(lon, lat) +
    SYNTHETIC_PEAK.peakMetres *
      Math.exp(-(d * d) / (2 * SYNTHETIC_PEAK.sigmaKm ** 2))
  );
}

export function createSyntheticTerrain(): CustomHeightmapTerrainProvider {
  const provider: CustomHeightmapTerrainProvider =
    new CustomHeightmapTerrainProvider({
      height: TILE_SAMPLES,
      width: TILE_SAMPLES,
      // Rows run north to south, columns west to east.
      callback: (x, y, level) => {
        const { east, north, south, west } =
          provider.tilingScheme.tileXYToRectangle(x, y, level);
        const heights = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
        const step = 1 / (TILE_SAMPLES - 1);
        for (let row = 0; row < TILE_SAMPLES; row++) {
          const lat = CesiumMath.toDegrees(
            north - (north - south) * row * step,
          );
          for (let column = 0; column < TILE_SAMPLES; column++) {
            const lon = CesiumMath.toDegrees(
              west + (east - west) * column * step,
            );
            heights[row * TILE_SAMPLES + column] = syntheticTerrainHeight(
              lon,
              lat,
            );
          }
        }
        return heights;
      },
    });
  return provider;
}

/**
 * `SYNTHETIC_PEAK`'s summit on the rendered (exaggerated) ground, in canvas CSS px: null while the
 * globe has no tile under it, behind the camera, or outside the canvas.
 */
function apexWindow(scene: CesiumWidget['scene']): TerrainProbe['apexWindow'] {
  const { lat, lon } = SYNTHETIC_PEAK;
  const ground = scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
  if (ground === undefined) return null;
  const position = SceneTransforms.worldToWindowCoordinates(
    scene,
    Cartesian3.fromDegrees(lon, lat, ground),
  );
  // Cesium returns undefined only behind the camera; off the canvas it still returns a position.
  if (position === undefined) return null;
  const { clientHeight, clientWidth } = scene.canvas;
  const { x, y } = position;
  return x >= 0 && x < clientWidth && y >= 0 && y < clientHeight
    ? { x, y }
    : null;
}

/** Publishes `window.__atlasTerrainProbe` for this widget; returns its removal. */
export function publishTerrainProbe(widget: CesiumWidget): () => void {
  const read = (): TerrainProbe => {
    const { camera, scene, terrainProvider } = widget;
    const { globe } = scene;
    const position = camera.positionCartographic;
    return {
      apexWindow: apexWindow(scene),
      cameraHeight: position.height,
      enableLighting: globe.enableLighting,
      groundHeight: globe.getHeight(position) ?? null,
      lambertDiffuseMultiplier: globe.lambertDiffuseMultiplier,
      provider:
        terrainProvider instanceof CustomHeightmapTerrainProvider
          ? 'synthetic'
          : terrainProvider instanceof EllipsoidTerrainProvider
            ? 'ellipsoid'
            : 'other',
      showGroundAtmosphere: globe.showGroundAtmosphere,
      showWaterEffect: globe.showWaterEffect,
      sunLight: scene.light instanceof SunLight,
      tilesLoaded: globe.tilesLoaded,
      verticalExaggeration: scene.verticalExaggeration,
      verticalExaggerationRelativeHeight:
        scene.verticalExaggerationRelativeHeight,
      vertexShadowDarkness: globe.vertexShadowDarkness,
    };
  };
  window.__atlasTerrainProbe = read;
  return () => {
    if (window.__atlasTerrainProbe === read) delete window.__atlasTerrainProbe;
  };
}
