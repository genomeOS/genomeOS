/**
 * Test-only hooks for the e2e build (fast-load design §B.8; #453), with the synthetic World
 * Terrain's probe and peak, and the placement readers that find a point above the rendered ground
 * and a label's clearance over it (terrain draping design, "Test plan" and "Per layer under World
 * Terrain"; #483), the drape stats reader, and the performance measures the World Terrain tour
 * attributes its long frames with ("Performance budget and measurement"): one per pass that picks
 * the ground under the draped observations or the grounded highlight, and one per draped layer
 * read ready, naming the rule that fired.
 * Each is inert unless the build sets `PUBLIC_ATLAS_E2E_HOOKS=1`, which only `npm run build:e2e`
 * may do (`assertE2eHooks`, lib/catalog-build.ts), so no production build carries them.
 */

import type { CesiumWidget, TerrainProvider } from 'cesium';

import type { AtlasImageryLayerName } from './geometry/raster/types';
import type { DrapeStats } from './scene/types';

/** Whether the camera is still moving, as `window.__atlasCameraMotion` reports it. */
export interface CameraMotion {
  /** A flight the scene started has neither completed nor been cancelled. */
  flying: boolean;
  /**
   * A frame drawn in the last `CAMERA_QUIET_MS` moved the camera by more than
   * `CAMERA_STILL_TOLERANCE` of its pose (`cameraMotionTestHook`).
   */
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
    /**
     * Where a point `aboveGroundMetres` above the rendered (exaggerated) ground at (`lon`, `lat`)
     * shows, in canvas CSS px; null until that ground has loaded, or off screen. Published with
     * the probe.
     */
    __atlasWindowOf?: (
      lon: number,
      lat: number,
      aboveGroundMetres: number,
    ) => { x: number; y: number } | null;
    /**
     * How far the scene's label reading `text` stands above the rendered ground under it, in
     * metres; null when no label reads `text` or its ground has not loaded. Published with the
     * probe.
     */
    __atlasLabelClearance?: (text: string) => number | null;
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
  /** The camera's latitude and longitude, in degrees. */
  cameraLat: number;
  cameraLon: number;
  /** The rendered (exaggerated) ground under the camera; null until its tile has loaded. */
  groundHeight: number | null;
  tilesLoaded: boolean;
  /**
   * An `atlas-surface` imagery layer is shown at alpha > 0: the surface is draped onto the ground
   * (terrain draping design, "Per layer under World Terrain").
   */
  draped: boolean;
  /**
   * The largest alpha among the shown `atlas-surface` layers, 0 with none. `draped` also holds in
   * the one frame a new surface layer draws at `PREWARM_ALPHA` (0.001) to compile its globe shader
   * unseen; its fade has begun once this is above that.
   */
  surfaceAlpha: number;
  /**
   * The imagery layers shown at alpha > 0, bottom to top, by their Atlas names
   * (`AtlasImageryLayerName`); every other layer is `'basemap'`.
   */
  imageryLayers: string[];
  /**
   * Every imagery layer on the globe's collection, bottom to top, shown or not and at any alpha:
   * by its Atlas name, `'guard'` for the draped base guard, `'basemap'` for any other layer. So a
   * test sees a layer added at alpha 0, and that none is left behind once the data leaves.
   */
  layerStack: string[];
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

/**
 * The performance measure of one pass that picks the ground: under the draped observations
 * (`scene/ground-heights.ts`) or under the grounded highlight ring (`scene/highlight-layer.ts`);
 * e2e build only.
 */
export const GROUND_PASS_MEASURE = 'atlas-ground-pass';

/** What a ground pass measure carries besides its start and duration. */
export interface GroundPassDetail {
  /** The points the pass picked the ground under (`globe.getHeight` calls). */
  points: number;
  /**
   * Under the observations: `create`, the sample at creation; `resample`, a throttled re-sample
   * (a relief frame, a tile load); `final`, an unthrottled one (the relief at rest, the tile load
   * queue empty, a morph between views complete). `highlight`: the hover or selection ring
   * grounded under World Terrain.
   */
  kind: 'create' | 'resample' | 'final' | 'highlight';
}

/**
 * The performance measure of a draped layer read ready (`scene/draped/draped-imagery-layer.ts`),
 * from its add or last show to the frame that read it ready; e2e build only.
 */
export const DRAPED_READY_MEASURE = 'atlas-draped-ready';

/** What a readiness measure carries besides its start and duration. */
export interface DrapedReadyDetail {
  layer: AtlasImageryLayerName;
  /**
   * `tiles`: the tiles the globe rendered had the layer's imagery loaded; `cap`: the fallback,
   * `DRAPED_READY_CAP_MS`, ran out first.
   */
  branch: 'tiles' | 'cap';
  /**
   * Whether `DRAPED_READY_CAP_MS` had run out by this frame, whatever the branch: a `tiles` read
   * with the cap run out came on the first frame past it, so either rule would have read the layer
   * ready.
   */
  capElapsed: boolean;
  /** The frames counted from the add or show, that one included. */
  frames: number;
}

/** A performance measure from `startMs` to `endMs` (`performance.now()` times), e2e build only. */
function e2eMeasure(
  name: string,
  startMs: number,
  endMs: number,
  detail: GroundPassDetail | DrapedReadyDetail,
): void {
  if (import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1') return;
  performance.measure(name, { detail, end: endMs, start: startMs });
}

/** Emits `GROUND_PASS_MEASURE` from `startMs` to `endMs`; nothing outside the e2e build. */
export function measureGroundPass(
  startMs: number,
  endMs: number,
  detail: GroundPassDetail,
): void {
  e2eMeasure(GROUND_PASS_MEASURE, startMs, endMs, detail);
}

/**
 * Runs `pick`, a pass that picks the ground, and emits `GROUND_PASS_MEASURE` for it on `now`, of
 * `kind` and with one point per entry of its result. A caller reaches it only through the build
 * constant (`import.meta.env.PUBLIC_ATLAS_E2E_HOOKS === '1' ? measuredGroundPass(…) : pass`), so a
 * production build keeps the bare pass and carries none of this.
 */
export function measuredGroundPass<T extends ArrayLike<unknown>>(
  kind: GroundPassDetail['kind'],
  pick: () => T,
  now: () => number = () => performance.now(),
): T {
  const start = now();
  const picked = pick();
  measureGroundPass(start, now(), { kind, points: picked.length });
  return picked;
}

/** Emits `DRAPED_READY_MEASURE` from `startMs` to `endMs`; nothing outside the e2e build. */
export function measureDrapedReady(
  startMs: number,
  endMs: number,
  detail: DrapedReadyDetail,
): void {
  e2eMeasure(DRAPED_READY_MEASURE, startMs, endMs, detail);
}

interface CameraEvent {
  addEventListener(listener: () => void): () => void;
}

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** The members of Cesium's camera the motion hook reads: its pose and its frustum's extent. */
export interface CameraPose {
  positionWC: Vector3;
  directionWC: Vector3;
  upWC: Vector3;
  /** `fov` in 3D, `right` and `top` in 2D (an off-centre orthographic frustum), else `width`. */
  frustum: { fov?: number; right?: number; top?: number; width?: number };
}

/**
 * A frame that changes no component of the camera's pose by more than this (relative to the
 * component, or absolute below 1) leaves the camera still. Cesium's own `moveStart` and `moveEnd`
 * compare at 1e-15 (`View.checkForCameraUpdates`), which the camera's float drift crosses: every
 * CesiumWidget's default EntityCluster listens to `camera.changed`, so Cesium reads the heading
 * and roll on each frame (`Camera._updateCameraChanged`), and each read writes the pose back
 * through an east-north-up frame (`Camera._setTransform`). Each crossing restarts Cesium's 0.5 s
 * wait, so at a hardware GPU's frame rate its `moveEnd` can be held off past a test's 30 s wait.
 */
export const CAMERA_STILL_TOLERANCE = 1e-12;

/** The camera is at rest once no frame has moved it this long: Cesium's `cameraEventWaitTime`. */
export const CAMERA_QUIET_MS = 500;

function poseOf({
  directionWC: d,
  frustum: f,
  positionWC: p,
  upWC: u,
}: CameraPose): number[] {
  return [
    p.x,
    p.y,
    p.z,
    d.x,
    d.y,
    d.z,
    u.x,
    u.y,
    u.z,
    f.fov ?? 0,
    f.right ?? 0,
    f.top ?? 0,
    f.width ?? 0,
  ];
}

function poseMoved(next: readonly number[], last: readonly number[]): boolean {
  return next.some((value, index) => {
    const before = last[index];
    return (
      Math.abs(value - before) >
      CAMERA_STILL_TOLERANCE * Math.max(1, Math.abs(value), Math.abs(before))
    );
  });
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
 * nothing. Motion is the camera's pose compared from one drawn frame (`postRender`) to the next,
 * not Cesium's `moveStart` and `moveEnd`, whose 1e-15 test the camera's float drift keeps failing
 * (`CAMERA_STILL_TOLERANCE`). Cesium draws every frame that moves the camera by more than that, so
 * no move goes unseen, and a camera at rest reads still `CAMERA_QUIET_MS` after its last move,
 * whether or not another frame is drawn.
 */
export function cameraMotionTestHook(
  scene: { camera: CameraPose; postRender: CameraEvent },
  now: () => number = () => performance.now(),
): CameraMotionHook | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined'
  )
    return undefined;
  let started = 0;
  let settled = 0;
  let pose: number[] | undefined;
  let movedAt = Number.NEGATIVE_INFINITY;
  const removeRender = scene.postRender.addEventListener(() => {
    const next = poseOf(scene.camera);
    if (pose !== undefined && poseMoved(next, pose)) movedAt = now();
    pose = next;
  });
  const read = (): CameraMotion => ({
    flying: settled !== started,
    moving: now() - movedAt < CAMERA_QUIET_MS,
  });
  window.__atlasCameraMotion = read;
  return {
    flight() {
      const flight = ++started;
      return () => {
        if (flight === started) settled = flight;
      };
    },
    destroy() {
      removeRender();
      // Only this scene's reader: a newer scene's stays published.
      if (window.__atlasCameraMotion === read)
        delete window.__atlasCameraMotion;
    },
  };
}
