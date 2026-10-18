/**
 * Test-only physical terrain for the e2e build (Atlas design §11; terrain draping design,
 * "Test plan"; #483). CI has no Cesium ion token, so World Terrain cannot load there; a browser
 * test that sets `window.__atlasSyntheticTerrain` gets this terrain of known height in its place
 * (`syntheticTerrainTestHook`, e2e-hooks.ts): a cone under Everest, and a Gaussian peak under the
 * HbS Spain survey, where the e2e fixture supports every nearby cell, so data drapes over relief.
 * The test reads the scene through `window.__atlasTerrainProbe`, which also lists the shown
 * imagery layers by their Atlas names (terrain draping design, "Per layer under World Terrain"),
 * so a test sees whether the data is draped, and every layer on the globe, hidden or at alpha 0.
 * With it come the placement readers: `window.__atlasWindowOf` finds a point a given height above
 * the rendered ground on the canvas, so a test can click a grounded symbol or sample a draped
 * footprint, and `window.__atlasLabelClearance` says how far a label stands above the ground.
 * Only the e2e build loads this module: the hook imports it dynamically behind
 * `PUBLIC_ATLAS_E2E_HOOKS`, so no production chunk carries it, nor the draped imagery-layer module
 * it names the layers with.
 */

import {
  Cartesian3,
  Cartographic,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  LabelCollection,
  Math as CesiumMath,
  PrimitiveCollection,
  SceneTransforms,
  SunLight,
  type CesiumWidget,
  type ImageryLayerCollection,
  type Label,
} from 'cesium';

import {
  SYNTHETIC_CONE,
  SYNTHETIC_PEAK,
  type TerrainProbe,
} from '../e2e-hooks';
import {
  drapedLayerName,
  isDrapedBaseGuard,
} from './draped/draped-imagery-layer';

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

type CanvasPoint = { x: number; y: number } | null;

/**
 * (`lon`, `lat`) `metres` above the ellipsoid, in canvas CSS px: null behind the camera or outside
 * the canvas.
 */
function canvasPoint(
  scene: CesiumWidget['scene'],
  lon: number,
  lat: number,
  metres: number,
): CanvasPoint {
  const position = SceneTransforms.worldToWindowCoordinates(
    scene,
    Cartesian3.fromDegrees(lon, lat, metres),
  );
  // Cesium returns undefined only behind the camera; off the canvas it still returns a position.
  if (position === undefined) return null;
  const { clientHeight, clientWidth } = scene.canvas;
  const { x, y } = position;
  return x >= 0 && x < clientWidth && y >= 0 && y < clientHeight
    ? { x, y }
    : null;
}

/**
 * `SYNTHETIC_PEAK`'s summit on the rendered (exaggerated) ground, `ground` metres up, in canvas CSS
 * px: null while the globe has no tile under it, behind the camera, or outside the canvas.
 */
function apexWindow(
  scene: CesiumWidget['scene'],
  ground: number | null,
): TerrainProbe['apexWindow'] {
  return ground === null
    ? null
    : canvasPoint(scene, SYNTHETIC_PEAK.lon, SYNTHETIC_PEAK.lat, ground);
}

/**
 * A point `aboveGroundMetres` above the rendered (exaggerated) ground at (`lon`, `lat`), in canvas
 * CSS px: null until the globe has a tile there, behind the camera, or outside the canvas.
 */
function windowOf(
  scene: CesiumWidget['scene'],
  lon: number,
  lat: number,
  aboveGroundMetres: number,
): CanvasPoint {
  const ground = scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
  return ground === undefined
    ? null
    : canvasPoint(scene, lon, lat, ground + aboveGroundMetres);
}

/** A Cesium label's private position on the ground (Label.js:1134), set once it is clamped. */
type ClampedLabel = Label & { _clampedPosition?: Cartesian3 };

/** The first label reading `text` in `collection`, searched depth first through its children. */
function findLabel(
  collection: PrimitiveCollection,
  text: string,
): ClampedLabel | null {
  for (let index = 0; index < collection.length; index += 1) {
    const child: unknown = collection.get(index);
    if (child instanceof PrimitiveCollection) {
      const found = findLabel(child, text);
      if (found) return found;
    } else if (child instanceof LabelCollection) {
      for (let at = 0; at < child.length; at += 1) {
        const label = child.get(at);
        if (label.text === text) return label;
      }
    }
  }
  return null;
}

/**
 * How far the label reading `text` stands above the rendered (exaggerated) ground under it, in
 * metres: from where Cesium clamped it when it is clamped to the ground, else from its own
 * position. Null when no label reads `text`, or the globe has no tile under it.
 */
function labelClearance(
  scene: CesiumWidget['scene'],
  text: string,
): number | null {
  const label = findLabel(scene.primitives, text);
  if (!label) return null;
  const at = Cartographic.fromCartesian(
    label._clampedPosition ?? label.position,
  );
  const ground = scene.globe.getHeight(at);
  return ground === undefined ? null : at.height - ground;
}

/**
 * The imagery layers the globe draws, bottom to top: each shown at alpha > 0, by its Atlas name, or
 * `'basemap'` for any other layer. The draped base guard, at alpha 0, is never among them.
 */
function shownImageryLayers(layers: ImageryLayerCollection): string[] {
  const shown: string[] = [];
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers.get(index);
    if (layer.show && layer.alpha > 0)
      shown.push(drapedLayerName(layer) ?? 'basemap');
  }
  return shown;
}

/** Every imagery layer on the collection, bottom to top, whatever its show and alpha. */
function imageryLayerStack(layers: ImageryLayerCollection): string[] {
  return Array.from({ length: layers.length }, (_, index) => {
    const layer = layers.get(index);
    if (isDrapedBaseGuard(layer)) return 'guard';
    return drapedLayerName(layer) ?? 'basemap';
  });
}

/**
 * Publishes `window.__atlasTerrainProbe` for this widget, with `window.__atlasWindowOf` and
 * `window.__atlasLabelClearance`; returns their removal.
 */
export function publishTerrainProbe(widget: CesiumWidget): () => void {
  const read = (): TerrainProbe => {
    const { camera, scene, terrainProvider } = widget;
    const { globe } = scene;
    const position = camera.positionCartographic;
    const apexGround =
      globe.getHeight(
        Cartographic.fromDegrees(SYNTHETIC_PEAK.lon, SYNTHETIC_PEAK.lat),
      ) ?? null;
    const imageryLayers = shownImageryLayers(scene.imageryLayers);
    return {
      apexGround,
      apexWindow: apexWindow(scene, apexGround),
      cameraHeight: position.height,
      draped: imageryLayers.includes('atlas-surface'),
      enableLighting: globe.enableLighting,
      groundHeight: globe.getHeight(position) ?? null,
      imageryLayers,
      lambertDiffuseMultiplier: globe.lambertDiffuseMultiplier,
      layerStack: imageryLayerStack(scene.imageryLayers),
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
  const windowOfPoint = (lon: number, lat: number, aboveGroundMetres: number) =>
    windowOf(widget.scene, lon, lat, aboveGroundMetres);
  const clearance = (text: string) => labelClearance(widget.scene, text);
  window.__atlasTerrainProbe = read;
  window.__atlasWindowOf = windowOfPoint;
  window.__atlasLabelClearance = clearance;
  return () => {
    if (window.__atlasTerrainProbe === read) delete window.__atlasTerrainProbe;
    if (window.__atlasWindowOf === windowOfPoint) delete window.__atlasWindowOf;
    if (window.__atlasLabelClearance === clearance)
      delete window.__atlasLabelClearance;
  };
}
