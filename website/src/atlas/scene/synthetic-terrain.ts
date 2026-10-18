/**
 * Test-only physical terrain for the e2e build (Atlas design §11; #483). CI has no Cesium ion
 * token, so World Terrain cannot load there; a browser test that sets
 * `window.__atlasSyntheticTerrain` gets this cone of known height in its place
 * (`syntheticTerrainTestHook`, e2e-hooks.ts), and reads the scene through
 * `window.__atlasTerrainProbe`. Only the e2e build loads this module: the hook imports it
 * dynamically behind `PUBLIC_ATLAS_E2E_HOOKS`, so no production chunk carries it.
 */

import {
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  Math as CesiumMath,
  SunLight,
  type CesiumWidget,
} from 'cesium';

import { SYNTHETIC_CONE, type TerrainProbe } from '../e2e-hooks';

export { SYNTHETIC_CONE } from '../e2e-hooks';

const EARTH_RADIUS_KM = 6_371;
const TILE_SAMPLES = 33;

/** The cone's height (metres) at a point, by great-circle distance from its apex. */
export function syntheticConeHeight(lon: number, lat: number): number {
  const φ1 = CesiumMath.toRadians(SYNTHETIC_CONE.lat);
  const φ2 = CesiumMath.toRadians(lat);
  const Δλ = CesiumMath.toRadians(lon - SYNTHETIC_CONE.lon);
  const cosine =
    Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const distanceKm =
    EARTH_RADIUS_KM * Math.acos(Math.min(1, Math.max(-1, cosine)));
  return (
    SYNTHETIC_CONE.peakMetres *
    Math.max(0, 1 - distanceKm / SYNTHETIC_CONE.radiusKm)
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
            heights[row * TILE_SAMPLES + column] = syntheticConeHeight(
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

/** Publishes `window.__atlasTerrainProbe` for this widget; returns its removal. */
export function publishTerrainProbe(widget: CesiumWidget): () => void {
  const read = (): TerrainProbe => {
    const { camera, scene, terrainProvider } = widget;
    const position = camera.positionCartographic;
    return {
      cameraHeight: position.height,
      enableLighting: scene.globe.enableLighting,
      groundHeight: scene.globe.getHeight(position) ?? null,
      provider:
        terrainProvider instanceof CustomHeightmapTerrainProvider
          ? 'synthetic'
          : terrainProvider instanceof EllipsoidTerrainProvider
            ? 'ellipsoid'
            : 'other',
      sunLight: scene.light instanceof SunLight,
      tilesLoaded: scene.globe.tilesLoaded,
      verticalExaggeration: scene.verticalExaggeration,
      verticalExaggerationRelativeHeight:
        scene.verticalExaggerationRelativeHeight,
    };
  };
  window.__atlasTerrainProbe = read;
  return () => {
    if (window.__atlasTerrainProbe === read) delete window.__atlasTerrainProbe;
  };
}
