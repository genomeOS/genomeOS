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
 * The heights are re-sampled when the ground they read can have changed: as terrain tiles load
 * (`tileLoadProgressEvent`, at most every `GROUND_RESAMPLE_MS`, and once more, unthrottled, when
 * the load queue empties); once a morph between 3D, 2D and Columbus view completes ("2D and
 * Columbus"); and whenever the owner calls `resample`, which a Physical relief drag does every
 * 50 ms and once more, final, when the slider rests ("Exaggeration"). Listeners hear only real
 * changes, compared value by value, so a re-sample that finds the same ground moves nothing.
 *
 * Cesium re-exaggerates the loaded tile meshes inside the frame after `verticalExaggeration`
 * changes, so until that frame renders `getHeight` still returns the old relief. `afterNextRender`
 * asks for that frame and runs its callback once the frame has rendered, which is when the scene
 * re-samples after a relief change.
 */

import {
  Cartographic,
  Math as CesiumMath,
  type Event,
  type Globe,
} from 'cesium';

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
 * tiles load and after each morph between views. Throws unless `lonLat` holds finite pairs.
 */
export function createGroundHeights(
  scene: {
    globe: Pick<Globe, 'getHeight' | 'tileLoadProgressEvent'>;
    morphComplete: Event;
  },
  lonLat: Float64Array,
  now: () => number = () => performance.now(),
): GroundHeights {
  assertLonLatPairs(lonLat);
  const firstBad = lonLat.findIndex((value) => !Number.isFinite(value));
  if (firstBad !== -1) {
    const pair = Math.floor(firstBad / 2);
    throw new Error(
      `ground heights need finite lon, lat pairs: pair ${pair} is (${lonLat[2 * pair]}, ${lonLat[2 * pair + 1]})`,
    );
  }
  const points = lonLat.slice();
  const { globe } = scene;
  const current = sampleGroundHeights(globe, points);
  const next = new Float64Array(current.length);
  const listeners = new Set<(h: Float64Array) => void>();
  let last = now();
  let destroyed = false;

  const resample = (final = false): void => {
    if (destroyed) return;
    const time = now();
    if (!final && time - last < GROUND_RESAMPLE_MS) return;
    last = time;
    sampleGroundHeights(globe, points, next);
    let changed = false;
    for (let i = 0; i < next.length; i += 1) {
      if (!Object.is(next[i], current[i])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    current.set(next);
    for (const listener of [...listeners]) listener(current);
  };

  const removeTileProgress = globe.tileLoadProgressEvent.addEventListener(
    (length: number) => {
      resample(length === 0);
    },
  );
  const removeMorphComplete = scene.morphComplete.addEventListener(() => {
    resample(true);
  });

  return {
    heights: () => current,
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
