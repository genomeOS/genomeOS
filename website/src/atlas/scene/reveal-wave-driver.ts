/** The scene's reveal-wave driver (#453; fast-load design §B.6.7 and §B.6.9 item 8, amended
 * 2026-10-13).
 *
 * Thin by design: the timeline lives in `reveal-wave.ts`. A wave starts from the centre of the
 * current view; on each frame (Cesium raises `preUpdate` on every tick of the render loop) the
 * driver moves the shared uniforms along the timeline and requests a render whenever the ring has
 * moved (the scene renders on request), and once the wave is done it stops requesting renders
 * and unsubscribes. It writes no buffer, so nothing is rebuilt or downloaded for it.
 *
 * - `prefers-reduced-motion: reduce` runs no wave: everything shows at once, as before #453.
 * - A hidden tab renders no frames, so a wave hidden mid-way finishes at once (and one started in
 *   a hidden tab never runs): the page comes back to the whole surface, not to a stale wave.
 * - The wave's clock sums frame times, but one frame moves it by at most a quarter of the wave
 *   (`waveStep`), so a stalled frame (a long task or texture upload elsewhere in the page) pauses
 *   the ring rather than popping it to the end.
 * - `data-atlas-wave` on the explorer reads `pending` until the scene's first wave, then `running`
 *   or `done`; the User Timing measure `atlas:reveal-wave` spans the end of the wave's first
 *   drawn frame (where its clock starts) to its last frame. Tests and the cold-load harness read both.
 * - E2E builds alone may hold the wave at a progress (`hold`), so a browser test can sample a
 *   frame mid-wave deterministically (`atlasRevealWaveHold`, boot.ts).
 */

import {
  Cartesian2,
  Ellipsoid,
  IntersectionTests,
  Ray,
  SceneMode,
  type Cartesian3,
  type Scene,
} from 'cesium';

import {
  angleBetween,
  cellReveal,
  REVEAL_WAVE_MEASURE,
  restingWave,
  WAVE_COMPLETE_RADIUS,
  waveDone,
  waveOrigin,
  waveRadius,
  waveReach,
  waveStep,
  waveTimeline,
  WAVE_ATTRIBUTE,
  type RevealWaveUniforms,
  type Vec3,
  type WaveTimeline,
} from './reveal-wave';

export { REVEAL_WAVE_MEASURE, WAVE_ATTRIBUTE };

/** Where a wave spreads from and how far it goes, read from the camera when it starts. */
export interface WaveView {
  origin: Vec3;
  reach: number;
}

export interface RevealWaveScene {
  preUpdate: { addEventListener(listener: () => void): () => void };
  postRender: { addEventListener(listener: () => void): () => void };
  requestRender(): void;
}

export interface VisibilitySource {
  isHidden(): boolean;
  /** Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface RevealWaveOptions {
  scene: RevealWaveScene;
  view: () => WaveView;
  /** `.atlas-explorer`, through the scene's mark tracker. */
  target: { setAttribute(name: string, value: string): void } | null;
  now?: () => number;
  /** Defaults to a User Timing measure; times are those of `now`. */
  measure?: (name: string, start: number, end: number, detail: unknown) => void;
  /** Defaults to `document`. */
  visibility?: VisibilitySource;
  /** E2E builds only: the progress (0 to 1) at which the wave's clock stands; null runs free. */
  hold?: () => number | null;
}

export interface RevealWave {
  /** The state every surface and mask shader reads; written only by the driver. */
  readonly uniforms: RevealWaveUniforms;
  /** Starts a wave from the centre of the view, or under reduced motion shows everything at once. */
  start(reducedMotion: boolean): void;
  /** Ends a running wave with everything shown. */
  finish(): void;
  running(): boolean;
  /** How far the wave has grown the cell whose centre lies along `direction`, 0 to 1. */
  reveal(direction: Vec3): number;
  /** Told `true` when a wave starts and `false` when it ends. */
  onChange(listener: (running: boolean) => void): () => void;
  destroy(): void;
}

function measureWave(
  name: string,
  start: number,
  end: number,
  detail: unknown,
): void {
  try {
    performance.measure(name, { detail, end, start });
  } catch {
    // Diagnostic only: a clock mismatch must never stop the wave.
  }
}

const DOCUMENT_VISIBILITY: VisibilitySource = {
  isHidden: () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onChange(listener) {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

export function createRevealWave(options: RevealWaveOptions): RevealWave {
  const now = options.now ?? (() => performance.now());
  const measure = options.measure ?? measureWave;
  const visibility = options.visibility ?? DOCUMENT_VISIBILITY;
  const uniforms = restingWave();
  const listeners = new Set<(running: boolean) => void>();
  let timeline: WaveTimeline | null = null;
  let startedAt: number | null = null;
  // The wave's own clock: frame times summed, each at most a quarter of the wave (`waveStep`).
  let progressMs = 0;
  let lastFrameAt = 0;
  let removeFrame: (() => void) | null = null;
  let removeDrawn: (() => void) | null = null;
  let removeVisibility: (() => void) | null = null;
  let destroyed = false;

  const write = (state: 'pending' | 'running' | 'done') =>
    options.target?.setAttribute(WAVE_ATTRIBUTE, state);
  const notify = (running: boolean) => {
    for (const listener of [...listeners]) listener(running);
  };
  const unsubscribe = () => {
    removeFrame?.();
    removeFrame = null;
    removeDrawn?.();
    removeDrawn = null;
    removeVisibility?.();
    removeVisibility = null;
  };
  const end = () => {
    const ended = timeline;
    if (!ended) return;
    const at = now();
    timeline = null;
    uniforms.radius = WAVE_COMPLETE_RADIUS;
    unsubscribe();
    write('done');
    measure(REVEAL_WAVE_MEASURE, startedAt ?? at, at, {
      durationMs: ended.durationMs,
      reach: ended.reach,
    });
    options.scene.requestRender();
    notify(false);
  };
  const advance = (current: WaveTimeline, at: number): number => {
    const held = options.hold?.() ?? null;
    if (held !== null && Number.isFinite(held))
      progressMs = Math.min(1, Math.max(0, held)) * current.durationMs;
    else progressMs += waveStep(current, at - lastFrameAt);
    lastFrameAt = at;
    return progressMs;
  };
  // The wave's clock starts once its first frame is drawn: that frame may compile shaders and
  // upload the first chunk, and the ring must not be part way out before anything shows.
  const drawn = () => {
    removeDrawn?.();
    removeDrawn = null;
    if (!timeline || startedAt !== null) return;
    startedAt = now();
    lastFrameAt = startedAt;
    progressMs = 0;
    options.scene.requestRender();
  };
  const frame = () => {
    const current = timeline;
    if (!current || startedAt === null) return;
    const time = advance(current, now());
    if (waveDone(current, time)) {
      end();
      return;
    }
    const radius = waveRadius(current, time);
    // The scene renders on request: a frame whose ring has not moved (a held wave) needs none.
    if (radius === uniforms.radius) return;
    uniforms.radius = radius;
    options.scene.requestRender();
  };

  write('pending');
  return {
    uniforms,
    start(reducedMotion) {
      if (destroyed) return;
      if (reducedMotion || visibility.isHidden()) {
        if (timeline) end();
        else {
          uniforms.radius = WAVE_COMPLETE_RADIUS;
          write('done');
          options.scene.requestRender();
        }
        return;
      }
      const wasRunning = timeline !== null;
      const view = options.view();
      const next = waveTimeline(view.reach);
      timeline = next;
      startedAt = null;
      uniforms.origin = {
        x: view.origin[0],
        y: view.origin[1],
        z: view.origin[2],
      };
      uniforms.band = next.band;
      uniforms.radius = 0;
      removeFrame ??= options.scene.preUpdate.addEventListener(frame);
      removeDrawn ??= options.scene.postRender.addEventListener(drawn);
      removeVisibility ??= visibility.onChange(() => {
        if (visibility.isHidden()) end();
      });
      write('running');
      options.scene.requestRender();
      if (!wasRunning) notify(true);
    },
    finish() {
      if (!destroyed) end();
    },
    running: () => timeline !== null,
    reveal: (direction) =>
      cellReveal(
        angleBetween(direction, [
          uniforms.origin.x,
          uniforms.origin.y,
          uniforms.origin.z,
        ]),
        uniforms.radius,
        uniforms.band,
      ),
    onChange(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      destroyed = true;
      timeline = null;
      unsubscribe();
      listeners.clear();
    },
  };
}

export type WaveViewScene = Pick<Scene, 'mode'> & {
  camera: Pick<
    Scene['camera'],
    'directionWC' | 'pickEllipsoid' | 'positionCartographic' | 'positionWC'
  >;
  canvas: Pick<HTMLCanvasElement, 'clientHeight' | 'clientWidth'>;
};

function vec(point: Cartesian3): Vec3 {
  return [point.x, point.y, point.z];
}

/**
 * The view a wave spreads over. On the globe its origin is where the camera's view ray meets the
 * ellipsoid (with a frustum offset, the centre of the open area), else the point below the
 * camera; 2D and Columbus view draw in the map frame, so they ask the camera's ellipsoid pick at
 * the canvas centre. The wave reaches the horizon (cells lifted `liftMetres` show past it), or
 * only the farthest point of the view's edge when the globe fills the view; in 2D and Columbus
 * view an edge that shows no globe sends it round the whole globe.
 */
export function waveViewOf(scene: WaveViewScene, liftMetres: number): WaveView {
  const { camera, canvas } = scene;
  const ellipsoid = Ellipsoid.WGS84;
  const globe = scene.mode === SceneMode.SCENE3D;
  let hit: Cartesian3 | undefined;
  let position: Cartesian3;
  if (globe) {
    position = camera.positionWC;
    const ray = new Ray(camera.positionWC, camera.directionWC);
    const interval = IntersectionTests.rayEllipsoid(ray, ellipsoid);
    hit = interval ? Ray.getPoint(ray, interval.start) : undefined;
  } else {
    position = ellipsoid.cartographicToCartesian(camera.positionCartographic);
    hit = camera.pickEllipsoid(
      new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      ellipsoid,
    );
  }
  const origin = waveOrigin(hit ? vec(hit) : null, vec(position));
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const border = [
    [0, 0],
    [width / 2, 0],
    [width, 0],
    [width, height / 2],
    [width, height],
    [width / 2, height],
    [0, height],
    [0, height / 2],
  ].map(([x, y]) => {
    const point = camera.pickEllipsoid(new Cartesian2(x, y), ellipsoid);
    return point ? vec(point) : null;
  });
  if (!globe && border.some((point) => point === null))
    return { origin, reach: Math.PI };
  return {
    origin,
    reach: waveReach(
      origin,
      vec(position),
      liftMetres,
      border,
      ellipsoid.minimumRadius,
    ),
  };
}
