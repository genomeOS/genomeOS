/**
 * Test-only hooks for the e2e build (fast-load design §B.8; #453), with the synthetic World
 * Terrain's probe and peak, and the placement readers that find a point above the rendered ground
 * and a label's clearance over it (terrain draping design, "Test plan" and "Per layer under World
 * Terrain"; #483), the drape stats reader, and the performance measures the World Terrain tour
 * attributes its long frames with ("Performance budget and measurement"): one per pass that picks
 * the ground under the draped observations or the grounded highlight, and one per draped layer
 * read ready, naming the rule that fired. The pick log lists what each hover frame and each click
 * resolved, so a browser test can hold a hover, resolved on the CPU, to the click's drill pick at
 * the same point (owner decision 2026-11-14 on #483). The country labels' reader tells a browser
 * test which labels the globe's horizon hides and where each one draws, and when asked records the
 * shown labels of every frame from the first label added (Atlas design §11; owner report
 * 2026-11-16).
 * Each is inert unless the build sets `PUBLIC_ATLAS_E2E_HOOKS=1`, which only `npm run build:e2e`
 * may do (`assertE2eHooks`, lib/catalog-build.ts), so no production build carries them.
 */

import type {
  Cartesian3,
  CesiumWidget,
  Label,
  Scene,
  TerrainProvider,
} from 'cesium';

import type { AtlasImageryLayerName } from './geometry/raster/types';
import type { AtlasPick, DrapeStats } from './scene/types';

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
    /** What each hover frame and each click resolved, in order (`pickLogTestHook`). */
    __atlasPickLog?: AtlasPickLogEntry[];
    /** Reads the country labels and the camera once they are added (`countryLabelsTestHook`). */
    __atlasCountryLabels?: () => CountryLabels;
    /**
     * Shows or hides the country labels alone, the borders kept, and asks for a frame, so a test
     * can compare what the labels draw.
     */
    __atlasDrawCountryLabels?: (drawn: boolean) => void;
    /**
     * Set to an empty list by a browser test before the page loads: each frame drawn once the
     * country labels exist appends the camera and the labels shown in it (`countryLabelsTestHook`).
     */
    __atlasCountryLabelFrames?: CountryLabelFrame[];
  }
}

/** One country label, as `window.__atlasCountryLabels` reports it. */
export interface CountryLabel {
  text: string;
  /** `Label.show`: false while the globe's horizon hides the label (scene/horizon.ts). */
  show: boolean;
  /**
   * Where Cesium draws it, ECEF metres: where it clamped it to the ground when it is clamped,
   * else its own position.
   */
  position: [number, number, number];
  /** The far end of its distance display condition, metres from the camera. */
  far: number;
  /**
   * Its box on the canvas in CSS px, as Cesium estimates it without its scale by distance; null
   * behind the camera.
   */
  box: { x: number; y: number; width: number; height: number } | null;
}

/** What `window.__atlasCountryLabels` reports (owner report 2026-11-16). */
export interface CountryLabels {
  /** The camera, ECEF metres. */
  camera: [number, number, number];
  /** The globe has loaded every tile this view needs. */
  tilesLoaded: boolean;
  labels: CountryLabel[];
}

/** One frame drawn with the country labels, as `window.__atlasCountryLabelFrames` records it. */
export interface CountryLabelFrame {
  /** The camera, ECEF metres. */
  camera: [number, number, number];
  /** The labels shown when it was drawn, each where Cesium draws it. */
  shown: Pick<CountryLabel, 'far' | 'position' | 'text'>[];
}

/** The most frames `window.__atlasCountryLabelFrames` holds; later ones are not recorded. A cold
 * load draws a few hundred before its country labels settle. */
export const COUNTRY_LABEL_FRAMES_MAX = 2_000;

/** One resolution of the pointer, as `window.__atlasPickLog` lists it. */
export interface AtlasPickLogEntry {
  source: 'click' | 'hover';
  pick: AtlasPick | null;
  /** `performance.now()` as it was resolved. */
  at: number;
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

const triple = ({ x, y, z }: Cartesian3): [number, number, number] => [x, y, z];

/**
 * The camera and the shown labels of the frame just drawn. Where Cesium draws a label is where it
 * clamped it to the ground, else its own position (scene/horizon.ts `drawnPosition`, read here
 * without importing Cesium). Cesium raises postRender outside its try/catch; this reads fields.
 */
function labelFrame(
  scene: Pick<Scene, 'camera'>,
  labels: readonly Label[],
): CountryLabelFrame {
  return {
    camera: triple(scene.camera.positionWC),
    shown: labels
      .filter(({ show }) => show)
      .map((label) => ({
        far: label.distanceDisplayCondition?.far ?? Number.POSITIVE_INFINITY,
        position: triple(
          (label as { _clampedPosition?: Cartesian3 })._clampedPosition ??
            label.position,
        ),
        text: label.text,
      })),
  };
}

/**
 * Publishes a reader of `scene`'s country labels as `window.__atlasCountryLabels`, and `draw` as
 * `window.__atlasDrawCountryLabels`, in the e2e build, so a browser test can tell which labels the
 * globe's horizon hides and what each one draws (owner report 2026-11-16); undefined elsewhere.
 * The reader's module (scene/country-label-probe.ts) loads only here, and both are published once
 * it has. The returned callback unpublishes them, unless a newer scene has published its own
 * since; called before the module loads, it publishes nothing.
 *
 * When a test has set `window.__atlasCountryLabelFrames` before the page loaded, every frame drawn
 * from the first label added appends to it at once, before the reader's module loads: a cold load
 * straight into a low view is held frame by frame, not only once it settles. The returned callback
 * stops the recording too.
 */
export function countryLabelsTestHook(
  scene: Scene,
  labels: () => readonly Label[],
  draw: (drawn: boolean) => void,
): (() => void) | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined'
  )
    return undefined;
  const frames = window.__atlasCountryLabelFrames;
  const stopRecording = Array.isArray(frames)
    ? scene.postRender.addEventListener(() => {
        const current = labels();
        if (current.length > 0 && frames.length < COUNTRY_LABEL_FRAMES_MAX)
          frames.push(labelFrame(scene, current));
      })
    : undefined;
  let removed = false;
  let read: (() => CountryLabels) | undefined;
  void import('./scene/country-label-probe').then(({ readCountryLabels }) => {
    if (removed) return;
    read = () => readCountryLabels(scene, labels());
    window.__atlasCountryLabels = read;
    window.__atlasDrawCountryLabels = draw;
  });
  return () => {
    removed = true;
    stopRecording?.();
    if (read && window.__atlasCountryLabels === read)
      delete window.__atlasCountryLabels;
    if (window.__atlasDrawCountryLabels === draw)
      delete window.__atlasDrawCountryLabels;
  };
}

/**
 * Appends each resolution of the pointer to `window.__atlasPickLog` in the e2e build (#483);
 * undefined elsewhere.
 */
export function pickLogTestHook():
  | ((source: AtlasPickLogEntry['source'], pick: AtlasPick | null) => void)
  | undefined {
  if (
    import.meta.env.PUBLIC_ATLAS_E2E_HOOKS !== '1' ||
    typeof window === 'undefined'
  )
    return undefined;
  return (source, pick) => {
    (window.__atlasPickLog ??= []).push({
      at: performance.now(),
      pick,
      source,
    });
  };
}

/**
 * The performance measure of one pass that reads the ground: under the draped observations
 * (`scene/ground-heights.ts`) or under the grounded highlight ring (`scene/highlight-layer.ts`);
 * e2e build only. A pass picks only the points whose terrain mesh changed, so one over unchanged
 * tiles, or after a relief change, picks none (`scene/ground-points.ts`).
 */
export const GROUND_PASS_MEASURE = 'atlas-ground-pass';

/** What a ground pass measure carries besides its start and duration. */
export interface GroundPassDetail {
  /** The points the pass picked the ground under (`globe.getHeight` calls); 0 if none. */
  points: number;
  /**
   * Under the observations: `create`, the sample at creation; `resample`, a throttled re-sample
   * (a relief frame, a tile load); `final`, an unthrottled one (the relief at rest, the tile load
   * queue empty, a morph between views complete); `continue`, the next frame's pass that picks
   * what a frame's budget of picks left. `highlight`: the hover or selection ring grounded under
   * World Terrain.
   */
  kind: 'create' | 'resample' | 'final' | 'continue' | 'highlight';
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
  /**
   * Whether the tiles the globe rendered in the frame read from were the ones it chose for the
   * view, not coarser ones drawn while finer terrain loaded: always for `tiles`; a `cap` read
   * without it waited on the terrain, one with it on the layer's own imagery.
   */
  settled: boolean;
  /** The deepest level of the tiles the globe rendered in the frame read from; −1 with none. */
  renderedLevel: number;
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
 * Runs `pass`, a pass that reads the ground and returns the points it picked, and emits
 * `GROUND_PASS_MEASURE` for it on `now`, of `kind` and with those points. A caller reaches it only
 * through the build constant (`import.meta.env.PUBLIC_ATLAS_E2E_HOOKS === '1' ?
 * measuredGroundPass(…) : pass()`), so a production build keeps the bare pass and carries none of
 * this.
 */
export function measuredGroundPass(
  kind: GroundPassDetail['kind'],
  pass: () => number,
  now: () => number = () => performance.now(),
): number {
  const start = now();
  const points = pass();
  measureGroundPass(start, now(), { kind, points });
  return points;
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
