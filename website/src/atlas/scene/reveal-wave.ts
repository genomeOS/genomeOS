/** The surface reveal wave's timeline and geometry (#453; fast-load design §B.6.7 and §B.6.9 item 8,
 * amended 2026-10-13, and 2026-10-14 for the screen-space timing).
 *
 * The surface appears as a ring that spreads from the point at the centre of the view to the
 * horizon. Each cell grows from its own centre and fades in while the ring passes over it: a cell
 * `angle` radians from the origin is nothing until the ring's leading edge (`radius`) reaches it
 * and fully grown once the edge is one ring width (`band`) past it.
 *
 * The wave is timed on screen, not on the globe. The globe's projection squeezes the outer angles
 * into a thin rim (from the home view, the outer half of the angle to the horizon draws in the
 * outer quarter of the disc's radius), so a ring that moved evenly in angle would cover most of
 * the disc at once and then crawl round the rim. Instead the ring's on-screen radius grows at one speed from
 * the centre to the limb, or to the edge of a view the globe fills, and eases out only over the
 * last fifth of `REVEAL_WAVE_MS`; its on-screen width is a fifth of that distance. On every frame
 * `waveFront` turns both back into angles for the shaders. Every visible cell is grown when the
 * time is up, and the far side then finishes at once (`WAVE_COMPLETE_RADIUS`).
 *
 * Pure and Cesium-free: the scene's driver feeds `waveFront` into the surface shaders' uniforms,
 * which repeat `cellReveal` on the GPU, and picking asks `cellReveal` on the CPU. Angles are
 * radians between geocentric (ECEF) directions; distances are metres, and `eye` is in globe radii.
 */

export type Vec3 = readonly [number, number, number];

/** The explorer attribute that reads `pending`, `running` or `done` (tests and the harness). */
export const WAVE_ATTRIBUTE = 'data-atlas-wave';
/** The User Timing measure of a wave, from its first drawn frame to its last frame. */
export const REVEAL_WAVE_MEASURE = 'atlas:reveal-wave';

/** From the wave's first frame until every visible cell is grown. The one tunable timing constant. */
export const REVEAL_WAVE_MS = 1_000;
/** The ring's on-screen width, as a fraction of the on-screen distance the wave covers. */
export const REVEAL_WAVE_BAND_FRACTION = 0.2;
/** The share of the wave, at its end, over which the ring slows to rest. */
export const REVEAL_WAVE_EASE_SHARE = 0.2;
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
  /** The ring's width: a cell this far inside the leading edge is fully grown. */
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
  /**
   * The angle at which the ring meets the limb on screen: the horizon seen from `eye`, or the
   * reach when that is nearer (a view the globe fills). Cells between it and the reach are lifted
   * cells beyond the horizon, which show at the limb itself.
   */
  limb: number;
  /**
   * The camera's distance from the globe's centre in globe radii, as if straight above the
   * origin; null in the map frame (2D and Columbus view), where distance on screen follows the
   * angle.
   */
  eye: number | null;
  durationMs: number;
}

/** The ring's leading edge and width, as angles, at one moment of a wave. */
export interface WaveFront {
  radius: number;
  band: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The share of its distance the ring has covered at `progress` (0 to 1) of the wave: one speed
 * until the last `REVEAL_WAVE_EASE_SHARE` of the time, then slowing evenly to rest at the end.
 * The speed is the same on both sides of the join.
 */
export function waveEase(progress: number): number {
  const t = clamp01(progress);
  const from = 1 - REVEAL_WAVE_EASE_SHARE;
  const speed = 2 / (1 + from);
  if (t <= from) return speed * t;
  return 1 - (speed / (2 * REVEAL_WAVE_EASE_SHARE)) * (1 - t) ** 2;
}

/**
 * How far from the origin on screen a point `angle` from it draws, for a camera `eye` globe radii
 * from the globe's centre straight above the origin (perspective; in units of the focal length,
 * which the timeline divides out). In the map frame (`eye` null) it is the angle itself. It grows
 * up to the horizon, `acos(1 / eye)`, and is odd in `angle`.
 */
export function screenDistance(angle: number, eye: number | null): number {
  if (eye === null) return angle;
  return Math.sin(angle) / (eye - Math.cos(angle));
}

/** The angle on the near side of the horizon that draws `distance` from the origin on screen. */
export function angleAtScreenDistance(
  distance: number,
  eye: number | null,
): number {
  if (eye === null) return distance;
  // sin θ + d cos θ = d · eye, so sin(θ + atan d) = d · eye / √(1 + d²).
  const sine = Math.min(
    1,
    Math.max(-1, (distance * eye) / Math.hypot(1, distance)),
  );
  return Math.asin(sine) - Math.atan(distance);
}

export function waveTimeline(
  reach: number,
  eye: number | null,
  durationMs = REVEAL_WAVE_MS,
): WaveTimeline {
  const covered = Number.isNaN(reach)
    ? Math.PI
    : Math.min(Math.PI, Math.max(MIN_WAVE_REACH, reach));
  // A camera at or inside the globe has no horizon to time against; the angle stands in.
  const projected = eye !== null && eye > 1 ? eye : null;
  return {
    durationMs,
    eye: projected,
    limb:
      projected === null
        ? covered
        : Math.max(MIN_WAVE_REACH, Math.min(covered, Math.acos(1 / projected))),
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

/**
 * The angle that draws `fraction` of the way from the origin to the limb on screen (or past it,
 * for the ring's last width). Short of the horizon that is the globe's own projection. The globe
 * draws nothing past the horizon, where lifted cells show at the limb itself, so there the
 * distance carries on as the projection's mirror image about the horizon: the ring's edge keeps
 * moving at the speed it met the limb with, and a cell at the limb grows as the ring passes it on
 * screen. In the map frame the angle is the distance.
 */
export function angleAtFraction(
  timeline: WaveTimeline,
  fraction: number,
): number {
  const { eye, limb } = timeline;
  const distance = fraction * screenDistance(limb, eye);
  if (eye === null) return Math.min(Math.PI, distance);
  const horizon = Math.acos(1 / eye);
  const atHorizon = screenDistance(horizon, eye);
  if (distance <= atHorizon) return angleAtScreenDistance(distance, eye);
  return Math.min(
    Math.PI,
    2 * horizon - angleAtScreenDistance(2 * atHorizon - distance, eye),
  );
}

/** The ring `elapsedMs` after the wave's first frame; once done, complete. */
export function waveFront(
  timeline: WaveTimeline,
  elapsedMs: number,
): WaveFront {
  if (waveDone(timeline, elapsedMs))
    return { band: 1, radius: WAVE_COMPLETE_RADIUS };
  // The leading edge runs to the limb plus one ring width, so the ring's trailing edge, where
  // cells are fully grown, reaches the limb as the time is up. Cells past it, beyond the edge of
  // the view or lifted past the horizon, finish when the wave does.
  const lead =
    (1 + REVEAL_WAVE_BAND_FRACTION) * waveEase(elapsedMs / timeline.durationMs);
  const radius = angleAtFraction(timeline, lead);
  const trail = angleAtFraction(timeline, lead - REVEAL_WAVE_BAND_FRACTION);
  return {
    band: Math.max(MIN_WAVE_REACH * REVEAL_WAVE_BAND_FRACTION, radius - trail),
    radius,
  };
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
