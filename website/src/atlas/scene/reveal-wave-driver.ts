/** The scene's reveal-wave driver (#453; fast-load design §B.6.7 and §B.6.9 item 8, amended
 * 2026-10-13).
 *
 * Thin by design: the timeline lives in `reveal-wave.ts`. A wave starts from the centre of the
 * current view; on each frame the driver moves the shared uniforms along the timeline and requests
 * the next render (the scene renders on request), and once the wave is done it stops requesting
 * renders and unsubscribes. It writes no buffer, so nothing is rebuilt or downloaded for it.
 *
 * - `prefers-reduced-motion: reduce` runs no wave: everything shows at once, as before #453.
 * - A hidden tab renders no frames, so a wave hidden mid-way finishes at once (and one started in
 *   a hidden tab never runs): the page comes back to the whole surface, not to a stale wave.
 * - `data-atlas-wave` on the explorer reads `pending` until the scene's first wave, then `running`
 *   or `done`; the User Timing measure `atlas:reveal-wave` spans the wave's first frame to its
 *   last. Tests and the cold-load harness read both.
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
  restingWave,
  WAVE_COMPLETE_RADIUS,
  waveDone,
  waveOrigin,
  waveRadius,
  waveReach,
  waveTimeline,
  type RevealWaveUniforms,
  type Vec3,
  type WaveTimeline,
} from './reveal-wave';

export const WAVE_ATTRIBUTE = 'data-atlas-wave';
export const REVEAL_WAVE_MEASURE = 'atlas:reveal-wave';

/** Where a wave spreads from and how far it goes, read from the camera when it starts. */
export interface WaveView {
  origin: Vec3;
  reach: number;
}

export interface RevealWaveScene {
  preUpdate: { addEventListener(listener: () => void): () => void };
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
  let removeFrame: (() => void) | null = null;
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
  const elapsed = (current: WaveTimeline, at: number): number => {
    const held = options.hold?.() ?? null;
    if (held !== null && Number.isFinite(held))
      return Math.min(1, Math.max(0, held)) * current.durationMs;
    return at - (startedAt ?? at);
  };
  const frame = () => {
    const current = timeline;
    if (!current) return;
    const at = now();
    startedAt ??= at;
    const time = elapsed(current, at);
    if (waveDone(current, time)) {
      end();
      return;
    }
    uniforms.radius = waveRadius(current, time);
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
