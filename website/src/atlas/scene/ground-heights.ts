/**
 * Ground heights under World Terrain, for terrain draping design, "Per layer under World Terrain"
 * (observation symbols), "Exaggeration", "2D and Columbus" and "Failure modes" (#483), and Atlas
 * design §11.
 *
 * Draped data lies on the rendered ground, so the observation symbols stand on it too: each symbol
 * keeps today's clearance above `globe.getHeight` at its anchor ("Per layer under World Terrain").
 * `getHeight` reads the terrain mesh Cesium has loaded and rendered, already raised by the scene's
 * vertical exaggeration, and returns undefined where no tile with a mesh covers the point. That
 * comes back here as NaN, and the symbol keeps the height it had until a tile loads ("Failure
 * modes": it may pop once). Terrain height only places symbols; it never enters a metric.
 *
 * The heights are re-read when the ground they read can have changed: as terrain tiles load
 * (`tileLoadProgressEvent`, at most every `GROUND_RESAMPLE_MS`, and once more, unthrottled, when
 * the load queue empties); once a morph between 3D, 2D and Columbus view completes ("2D and
 * Columbus"); and whenever the owner calls `resample`, which a Physical relief drag does every
 * 50 ms and once more, final, when the slider rests ("Exaggeration"). A pass picks only the points
 * whose rendered terrain mesh changed, and follows a relief change from each point's source height
 * without a pick (`ground-points.ts`), so a pass over unchanged tiles picks nothing. Listeners
 * hear only real changes, compared value by value, so a pass that finds the same ground moves
 * nothing.
 *
 * Cesium re-exaggerates the loaded tile meshes inside the frame after `verticalExaggeration`
 * changes, so until that frame renders the meshes still hold the old relief. `afterNextRender`
 * asks for that frame and runs its callback once the frame has rendered, which is when the scene
 * re-reads the ground after a relief change; `createReliefResampler` arms it for each relief
 * frame, and once more, final, when the slider rests. `throttleResample` is the 50 ms rule, which
 * the scene also applies to the highlight it grounds. `sampleGroundHeights` picks every point
 * once, for a one-off read.
 *
 * In the e2e build each pass emits a `GROUND_PASS_MEASURE` performance measure with the points it
 * picked and why it ran ("Performance budget and measurement"), so the World Terrain tour can
 * tell a long frame spent picking from one spent elsewhere. The build constant picks the measured
 * pass at each call site, so a production build keeps the bare pass and carries no measuring code.
 */

import {
  Cartographic,
  Math as CesiumMath,
  type Event,
  type Globe,
} from 'cesium';

import { measuredGroundPass, type GroundPassDetail } from '../e2e-hooks';
import {
  GroundPoints,
  type GroundGlobe,
  type GroundPass,
} from './ground-points';

/** The shortest interval between two throttled re-samples (a relief drag, loading tiles). */
export const GROUND_RESAMPLE_MS = 50;

/** One scratch position, reused for every point: sampling allocates nothing per point. */
const SCRATCH = new Cartographic();

function assertLonLatPairs(lonLat: Float64Array): void {
  if (lonLat.length % 2 !== 0) {
    throw new Error(
      `ground heights need lon, lat pairs: got ${lonLat.length} numbers`,
    );
  }
}

/**
 * The rendered ground height in metres under each `lon, lat` pair (WGS84 degrees), NaN where no
 * loaded tile covers the point. Longitudes are wrapped into [-180°, 180°], where `getHeight` finds
 * its tiles. Writes into `out` when given (one slot per pair) and returns it.
 */
export function sampleGroundHeights(
  globe: Pick<Globe, 'getHeight'>,
  lonLat: Float64Array,
  out?: Float64Array,
): Float64Array {
  assertLonLatPairs(lonLat);
  const count = lonLat.length / 2;
  if (out && out.length !== count) {
    throw new Error(
      `ground heights for ${count} points need ${count} slots: got ${out.length}`,
    );
  }
  const heights = out ?? new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    SCRATCH.longitude = CesiumMath.negativePiToPi(
      CesiumMath.toRadians(lonLat[2 * i]),
    );
    SCRATCH.latitude = CesiumMath.toRadians(lonLat[2 * i + 1]);
    SCRATCH.height = 0;
    heights[i] = globe.getHeight(SCRATCH) ?? Number.NaN;
  }
  return heights;
}

/** The ground heights under a fixed set of points, kept current as the rendered ground changes. */
export interface GroundHeights {
  /** One height per point, NaN where no tile has loaded. The array is reused: read, never keep. */
  heights(): Float64Array;
  /**
   * Calls `l` after a re-sample that changed a height. `l` receives the internal array (the same
   * one `heights()` returns), which the next re-sample overwrites: copy what you keep. Returns the
   * unsubscribe.
   */
  onChange(l: (h: Float64Array) => void): () => void;
  /** Re-samples now, unless the last sample was under `GROUND_RESAMPLE_MS` ago and not `final`. */
  resample(final?: boolean): void;
  /** Stops listening to the scene and to callers; later re-samples do nothing. */
  destroy(): void;
}

/**
 * Samples the ground under `lonLat` (WGS84 degree pairs) at once, then re-samples as terrain
 * tiles load and after each morph between views. Throws unless `lonLat` holds finite pairs. `now`
 * is the performance timeline's clock: the throttle reads it, and the e2e build's pass measures.
 */
export function createGroundHeights(
  scene: {
    globe: GroundGlobe & Pick<Globe, 'tileLoadProgressEvent'>;
    morphComplete: Event;
  },
  lonLat: Float64Array,
  now: () => number = () => performance.now(),
): GroundHeights {
  const points = new GroundPoints(lonLat);
  const { globe } = scene;
  const listeners = new Set<(h: Float64Array) => void>();
  let destroyed = false;

  const sample = (kind: GroundPassDetail['kind']): void => {
    let pass: GroundPass | undefined;
    const read = () => (pass = points.update(globe)).picked;
    if (import.meta.env.PUBLIC_ATLAS_E2E_HOOKS === '1')
      measuredGroundPass(kind, read, now);
    else read();
    if (!pass?.changed) return;
    for (const listener of [...listeners]) listener(points.heights);
  };
  sample('create');
  // The sample at creation counts as the last one.
  const throttled = throttleResample(
    (final) => sample(final ? 'final' : 'resample'),
    now,
    now(),
  );
  const resample = (final = false): void => {
    if (!destroyed) throttled(final);
  };

  const removeTileProgress = onTileLoads(globe, resample);
  const removeMorphComplete = scene.morphComplete.addEventListener(() => {
    resample(true);
  });

  return {
    heights: () => points.heights,
    onChange(l) {
      if (destroyed) return () => {};
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    resample,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeTileProgress();
      removeMorphComplete();
      listeners.clear();
    },
  };
}

/**
 * Calls `resample` each time the globe's tile load queue changes length, `final` once it is empty.
 * Returns the remover.
 */
export function onTileLoads(
  globe: Pick<Globe, 'tileLoadProgressEvent'>,
  resample: (final: boolean) => void,
): () => void {
  return globe.tileLoadProgressEvent.addEventListener((queued: number) =>
    resample(queued === 0),
  );
}

/**
 * Requests a frame and runs `run` once, after that frame has rendered (the scene's next
 * `postRender`), when `getHeight` reads a relief change the frame applied. Returns a remover that
 * cancels `run` if the frame has not rendered yet.
 */
export function afterNextRender(
  scene: {
    postRender: { addEventListener(l: () => void): () => void };
    requestRender(): void;
  },
  run: () => void,
): () => void {
  let pending = true;
  const remove = scene.postRender.addEventListener(() => {
    if (!pending) return;
    pending = false;
    remove();
    run();
  });
  scene.requestRender();
  return () => {
    if (!pending) return;
    pending = false;
    remove();
  };
}

/**
 * `run`, called with `final`, except a call that is not final within `GROUND_RESAMPLE_MS` of the
 * last one that ran, which is dropped. `last` is when the last run was, if one came before.
 */
export function throttleResample(
  run: (final: boolean) => void,
  now: () => number = () => performance.now(),
  last = Number.NEGATIVE_INFINITY,
): (final?: boolean) => void {
  return (final = false) => {
    const time = now();
    if (!final && time - last < GROUND_RESAMPLE_MS) return;
    last = time;
    run(final);
  };
}

/** Re-samples the ground after relief changes; see `createReliefResampler`. */
export interface ReliefResampler {
  /** A relief frame has set a new exaggeration. */
  changed(): void;
  /** Drops the re-samples still pending. */
  cancel(): void;
}

/**
 * After each relief change, `resample(false)` once the next frame has rendered it; once the changes
 * have rested for `GROUND_RESAMPLE_MS`, `resample(true)` after the frame that follows. A change
 * replaces the re-sample still waiting for its frame.
 */
export function createReliefResampler(
  scene: Parameters<typeof afterNextRender>[0],
  resample: (final: boolean) => void,
): ReliefResampler {
  let cancelRender: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    cancelRender?.();
    cancelRender = null;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    changed() {
      cancel();
      cancelRender = afterNextRender(scene, () => resample(false));
      timer = setTimeout(() => {
        cancelRender?.();
        cancelRender = afterNextRender(scene, () => resample(true));
      }, GROUND_RESAMPLE_MS);
    },
    cancel,
  };
}
