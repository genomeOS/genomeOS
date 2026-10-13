/** The surface reveal wave's timeline and geometry (#453; fast-load design §B.6.7 and §B.6.9 item 8,
 * amended 2026-10-13).
 *
 * The surface appears as a ring that spreads from the point at the centre of the view to the
 * horizon. Each cell grows from its own centre and fades in while the ring passes over it: a cell
 * `angle` radians from the origin is nothing until the ring's leading edge (`radius`) reaches it
 * and fully grown once the edge is one ring width (`band`) past it. The edge eases out over
 * `REVEAL_WAVE_MS`, reaching the horizon plus one band, so every visible cell is grown when the
 * time is up; the far side then finishes at once (`WAVE_COMPLETE_RADIUS`).
 *
 * Pure and Cesium-free: the scene's driver feeds `waveRadius` into the surface shaders' uniforms,
 * which repeat `cellReveal` on the GPU, and picking asks `cellReveal` on the CPU. Angles are
 * radians between geocentric (ECEF) directions; distances are metres.
 */

export type Vec3 = readonly [number, number, number];

/** The explorer attribute that reads `pending`, `running` or `done` (tests and the harness). */
export const WAVE_ATTRIBUTE = 'data-atlas-wave';
/** The User Timing measure of a wave, from its first drawn frame to its last frame. */
export const REVEAL_WAVE_MEASURE = 'atlas:reveal-wave';

/** From the wave's first frame to the horizon. The one tunable timing constant. */
export const REVEAL_WAVE_MS = 800;
/** The ring's width, as a fraction of the angle the wave covers. */
export const REVEAL_WAVE_BAND_FRACTION = 0.2;
/** The smallest reach (about 64 m of arc), so the ring always has a width to divide by. */
export const MIN_WAVE_REACH = 1e-5;
/**
 * A leading edge past any angle (π) plus any band: everything is shown, and the shaders skip the
 * per-vertex angle. It is also the resting value, so a surface built outside a wave is whole.
 */
export const WAVE_COMPLETE_RADIUS = 8;

/** What every surface and mask chunk's shader reads on each draw; the scene's driver writes it. */
export interface RevealWaveUniforms {
  /** Unit ECEF direction of the wave's origin (a Cesium `vec3` uniform takes any x, y, z). */
  origin: { x: number; y: number; z: number };
  /** The ring's leading edge. */
  radius: number;
  band: number;
}

/** The state outside a wave: complete, so every cell is whole. */
export function restingWave(): RevealWaveUniforms {
  return {
    band: 1,
    origin: { x: 1, y: 0, z: 0 },
    radius: WAVE_COMPLETE_RADIUS,
  };
}

export interface WaveTimeline {
  /** The angle from the origin the wave must cover: the horizon or the edge of the view. */
  reach: number;
  /** The ring's width. */
  band: number;
  durationMs: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function easeOutCubic(progress: number): number {
  const t = clamp01(progress);
  return 1 - (1 - t) ** 3;
}

export function waveTimeline(
  reach: number,
  durationMs = REVEAL_WAVE_MS,
): WaveTimeline {
  const covered = Number.isNaN(reach)
    ? Math.PI
    : Math.min(Math.PI, Math.max(MIN_WAVE_REACH, reach));
  return {
    band: covered * REVEAL_WAVE_BAND_FRACTION,
    durationMs,
    reach: covered,
  };
}

/**
 * How far one frame `frameMs` long moves the wave's clock: its own time, but at most a quarter
 * of the wave. A stalled frame (a long task, a texture upload) would otherwise swallow most of the
 * wave, and the ring would freeze and then pop to the end instead of spreading.
 */
export function waveStep(timeline: WaveTimeline, frameMs: number): number {
  return Math.min(timeline.durationMs / 4, Math.max(0, frameMs));
}

export function waveDone(timeline: WaveTimeline, elapsedMs: number): boolean {
  return elapsedMs >= timeline.durationMs;
}

/** The ring's leading edge `elapsedMs` after the wave's first frame. */
export function waveRadius(timeline: WaveTimeline, elapsedMs: number): number {
  if (waveDone(timeline, elapsedMs)) return WAVE_COMPLETE_RADIUS;
  return (
    (timeline.reach + timeline.band) *
    easeOutCubic(elapsedMs / timeline.durationMs)
  );
}

/** How far a cell `angle` from the origin has grown, 0 to 1; the shaders repeat this. */
export function cellReveal(
  angle: number,
  radius: number,
  band: number,
): number {
  if (radius >= WAVE_COMPLETE_RADIUS) return 1;
  return clamp01((radius - angle) / band);
}

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

export function angleBetween(first: Vec3, second: Vec3): number {
  const cosine =
    (first[0] * second[0] + first[1] * second[1] + first[2] * second[2]) /
    (length(first) * length(second));
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * The wave's origin as a unit vector: where the camera's view ray meets the globe (the centre of
 * the open area), else the point below the camera.
 */
export function waveOrigin(viewHit: Vec3 | null, camera: Vec3): Vec3 {
  const point = viewHit ?? camera;
  const size = length(point);
  return [point[0] / size, point[1] / size, point[2] / size];
}

/**
 * The largest angle from `origin` at which a cell lifted `liftMetres` can be seen from `camera`:
 * the origin's offset from the nadir, plus the camera's horizon on a sphere of `radius`, plus how
 * far past that horizon a lifted cell still shows. A smaller `radius` errs towards a longer wave.
 */
export function horizonReach(
  origin: Vec3,
  camera: Vec3,
  liftMetres: number,
  radius: number,
): number {
  const distance = length(camera);
  if (distance <= radius) return Math.PI;
  const reach =
    angleBetween(origin, camera) +
    Math.acos(radius / distance) +
    Math.acos(radius / (radius + Math.max(0, liftMetres)));
  return Math.min(Math.PI, reach);
}

/**
 * The angle the wave covers. `border` samples the edge of the view where it meets the globe
 * (`null` where it shows sky). When the globe fills the view, the wave need go no further than
 * the farthest of them; otherwise it runs to the horizon.
 */
export function waveReach(
  origin: Vec3,
  camera: Vec3,
  liftMetres: number,
  border: readonly (Vec3 | null)[],
  radius: number,
): number {
  const horizon = horizonReach(origin, camera, liftMetres, radius);
  if (border.length === 0 || border.some((point) => point === null))
    return horizon;
  const farthest = Math.max(
    ...border.map((point) => angleBetween(origin, point!)),
  );
  return Math.min(horizon, farthest);
}
