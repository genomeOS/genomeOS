/**
 * Test-only hooks for the e2e build (fast-load design §B.8; #453), with the synthetic World
 * Terrain's probe and peak (terrain draping design, "Test plan"; #483) and the drape stats reader
 * ("Performance budget and measurement"). Each is inert unless the build sets
 * `PUBLIC_ATLAS_E2E_HOOKS=1`, which only `npm run build:e2e` may do (`assertE2eHooks`,
 * lib/catalog-build.ts), so no production build carries them.
 */

import type { CesiumWidget, TerrainProvider } from 'cesium';

import type { DrapeStats } from './scene/types';

/** Whether the camera is still moving, as `window.__atlasCameraMotion` reports it. */
export interface CameraMotion {
  /** A flight the scene started has neither completed nor been cancelled. */
  flying: boolean;
  /** Cesium raised `moveStart` and no `moveEnd` since (the camera changed in the last 0.5 s). */
  moving: boolean;
}

declare global {
  interface Window {
    /**
     * The progress (0 to 1) at which a browser test holds the surface reveal wave, so it can
     * sample a frame mid-wave; unset or null lets the wave run.
     */
    __atlasRevealWaveHold?: number | null;
    /** Reads the camera's motion, so a browser test can wait out a flight. */
    __atlasCameraMotion?: () => CameraMotion;
    /** Set by a browser test before the page loads: World Terrain becomes a synthetic cone. */
    __atlasSyntheticTerrain?: boolean;
    /** Reads the globe's terrain, lighting and camera, once the synthetic terrain is requested. */
    __atlasTerrainProbe?: () => TerrainProbe;
    /** Reads the draped tiles' counts, raster times and resident bytes, once draping has loaded. */
    __atlasDrapeStats?: () => DrapeStats;
  }
}

/** What `window.__atlasTerrainProbe` reports (#483). */
export interface TerrainProbe {
  provider: 'ellipsoid' | 'synthetic' | 'other';
  enableLighting: boolean;
  /** Whether the scene's light is Cesium's real-time sun. */
  sunLight: boolean;
  verticalExaggeration: number;
  verticalExaggerationRelativeHeight: number;
  /** Metres above the ellipsoid. */
  cameraHeight: number;
  /** The rendered (exaggerated) ground under the camera; null until its tile has loaded. */
  groundHeight: number | null;
  tilesLoaded: boolean;
  /**
   * The globe's hillshade and tint terms (terrain draping design, "Per layer under World
   * Terrain").
   */
  lambertDiffuseMultiplier: number;
  showGroundAtmosphere: boolean;
  showWaterEffect: boolean;
  vertexShadowDarkness: number;
  /**
   * The rendered (exaggerated) ground at `SYNTHETIC_PEAK`'s apex, in metres; null until its tile
   * loads. It reaches the true summit as finer tiles load there.
   */
  apexGround: number | null;
  /**
   * `SYNTHETIC_PEAK` on the rendered (exaggerated) ground, in canvas CSS px; null until its tile
   * loads or when off screen.
   */
  apexWindow: { x: number; y: number } | null;
}

/**
 * The synthetic terrain's cone (scene/synthetic-terrain.ts): 6 km high under Everest, 150 km in
 * radius. Here, free of Cesium, so a browser test can work out the ground it expects.
 */
export const SYNTHETIC_CONE = {
  lat: 27.988,
  lon: 86.925,
  peakMetres: 6_000,
  radiusKm: 150,
} as const;

/**
 * The synthetic terrain's Gaussian peak (scene/synthetic-terrain.ts): 6 km high, σ 40 km, under
 * the HbS Spain survey `map-surveys:1135` (MAP survey 1135, population label "Spain"), where the
 * e2e grid's hbs-rs334 render tier supports every res-4 cell within 2σ of the apex (res-4 cell
 * `84390cbffffffff`). None of the Kenya survey's 11 res-4 cells within 80 km is in that grid.
 */
export const SYNTHETIC_PEAK = {
  lat: 40.419,
  lon: -3.709,
  peakMetres: 6_000,
  sigmaKm: 40,
} as const;

export interface SyntheticTerrainHook {
  /** Builds the cone and peak that stand in for Cesium World Terrain. */
  worldTerrain(): Promise<TerrainProvider>;
  destroy(): void;
}

/**
 * The e2e build's stand-in for Cesium World Terrain (#483), when a browser test set
 * `window.__atlasSyntheticTerrain`; undefined elsewhere. CI has no ion token, so the test drives
 * World Terrain through the UI with terrain of known height, a cone and a Gaussian peak
 * (scene/synthetic-terrain.ts, loaded only here), and reads the scene through
 * `window.__atlasTerrainProbe`.
 */
export function syntheticTerrainTestHook(
  widget: CesiumWidget,
): SyntheticTerrainHook | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined' ||
    window.__atlasSyntheticTerrain !== true
  )
    return undefined;
  const module = import('./scene/synthetic-terrain');
  let destroyed = false;
  let unpublish: (() => void) | undefined;
  const published = module.then(({ publishTerrainProbe }) => {
    if (!destroyed) unpublish = publishTerrainProbe(widget);
  });
  return {
    worldTerrain: () =>
      published
        .then(() => module)
        .then(({ createSyntheticTerrain }) => createSyntheticTerrain()),
    destroy() {
      destroyed = true;
      unpublish?.();
    },
  };
}

/** The reveal wave's hold for the e2e build, read on each wave frame; undefined elsewhere. */
export function revealWaveTestHold(): (() => number | null) | undefined {
  if (import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1') return undefined;
  return () => {
    const hold =
      typeof window === 'undefined' ? undefined : window.__atlasRevealWaveHold;
    return typeof hold === 'number' ? hold : null;
  };
}

/**
 * Publishes `read` as `window.__atlasDrapeStats` in the e2e build (#483), so the World Terrain
 * budgets can be measured; undefined elsewhere. The returned callback unpublishes it, unless a
 * newer scene has published its own reader since.
 */
export function drapeStatsTestHook(
  read: () => DrapeStats,
): (() => void) | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined'
  )
    return undefined;
  window.__atlasDrapeStats = read;
  return () => {
    if (window.__atlasDrapeStats === read) delete window.__atlasDrapeStats;
  };
}

interface CameraEvent {
  addEventListener(listener: () => void): () => void;
}

export interface CameraMotionHook {
  /** Called as the scene moves the camera; the returned callback runs when that move settles. */
  flight(): () => void;
  destroy(): void;
}

/**
 * Publishes `window.__atlasCameraMotion` in the e2e build; undefined elsewhere. A browser test
 * that compares frames of one view reads it to wait out a camera flight: the camera's own state,
 * so the wait depends on no other content and needs no frame of the page (a screenshot waits for
 * several, each over a second under CI's software WebGL). A flight counts from the call that
 * starts it, before its first frame moves the camera; a flight that a newer one cancels settles
 * nothing.
 */
export function cameraMotionTestHook(camera: {
  moveStart: CameraEvent;
  moveEnd: CameraEvent;
}): CameraMotionHook | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined'
  )
    return undefined;
  let started = 0;
  let settled = 0;
  let moving = false;
  const removeStart = camera.moveStart.addEventListener(() => {
    moving = true;
  });
  const removeEnd = camera.moveEnd.addEventListener(() => {
    moving = false;
  });
  const read = (): CameraMotion => ({ flying: settled !== started, moving });
  window.__atlasCameraMotion = read;
  return {
    flight() {
      const flight = ++started;
      return () => {
        if (flight === started) settled = flight;
      };
    },
    destroy() {
      removeStart();
      removeEnd();
      // Only this scene's reader: a newer scene's stays published.
      if (window.__atlasCameraMotion === read)
        delete window.__atlasCameraMotion;
    },
  };
}
