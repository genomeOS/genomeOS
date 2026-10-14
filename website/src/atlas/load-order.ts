/** The post-reveal load order for Atlas design §11 (spec 2026-10-07 §B.2, §B.6.9; #443).
 *
 * Once the surface is visible, three loads would otherwise share one connection: the Natural
 * Earth borders that every visitor sees, the f64 detail tier that only the hover readout and the
 * inspector read, and the cosmetic starfield. They run one after another, in that order:
 *
 * 1. `borders` starts at once, once per scene.
 * 2. `detail`, once per displayed artifact, starts when the borders have settled, and at once when
 *    they already have, so a later artifact switch starts its detail tier as soon as its surface
 *    is visible.
 * 3. `starfield`, once per scene, starts when the borders and every detail step started so far
 *    have settled.
 *
 * A step settles when its task resolves, rejects or throws, or when it stalls: it neither settles
 * nor reports progress for the stall window. A failure or a stall releases the next step; a
 * stalled task keeps running, and its late outcome starts nothing twice. A queued detail step can
 * be cancelled until it starts; after that its task owns its own abort. Destroying the order drops
 * every step that has not started, clears its timers and ignores later outcomes.
 */

/** The provider's request stall window (`StaticAtlasDataProvider.defaultRequestStallMs`, §B.6.2). */
export const LOAD_STALL_MS = 15_000;

/** Called by a running task whenever it makes progress, such as a body chunk arriving. */
export type LoadProgress = () => void;
export type LoadTask = (progress: LoadProgress) => PromiseLike<unknown> | void;

export interface LoadOrder {
  /** Step 1. Later calls are ignored. */
  borders(task: LoadTask): void;
  /** Step 2. Returns a cancel that drops the step if it has not started. */
  detail(task: LoadTask): () => void;
  /** Step 3. Later calls are ignored. */
  starfield(task: LoadTask): void;
  destroy(): void;
}

export function createLoadOrder(stallMs: number = LOAD_STALL_MS): LoadOrder {
  if (!Number.isFinite(stallMs) || stallMs <= 0)
    throw new Error(
      `The Atlas load order needs a positive, finite stall window, not ${stallMs} ms`,
    );
  let destroyed = false;
  let bordersRequested = false;
  let bordersSettled = false;
  let starfieldRequested = false;
  let starfield: LoadTask | null = null;
  /** Detail steps waiting for the borders, in request order. */
  const queued = new Set<{ task: LoadTask }>();
  /** Detail steps started and not yet settled or stalled. */
  let running = 0;
  /** Stops the stall timer of every step still running. */
  const timers = new Set<() => void>();

  /** Runs `task` and calls `settled` exactly once: when it settles or stalls, unless destroyed. */
  const run = (task: LoadTask, settled: () => void): void => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      timers.delete(stop);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      stop();
      if (!destroyed) settled();
    };
    const arm = () => {
      if (finished || destroyed) return;
      clearTimeout(timer);
      timer = setTimeout(finish, stallMs);
      timers.add(stop);
    };
    arm();
    let result: PromiseLike<unknown> | void;
    try {
      result = task(arm);
    } catch {
      finish();
      return;
    }
    if (result && typeof result.then === 'function')
      Promise.resolve(result).then(finish, finish);
    else finish();
  };

  const considerStarfield = () => {
    if (destroyed || !starfield || !bordersSettled || running > 0) return;
    const task = starfield;
    starfield = null;
    run(task, () => undefined);
  };

  const detailSettled = () => {
    running -= 1;
    considerStarfield();
  };

  const startDetails = (tasks: readonly LoadTask[]) => {
    // Every released step counts as running before any starts, so one that settles in the same
    // turn cannot let the starfield in ahead of the others.
    running += tasks.length;
    for (const task of tasks) run(task, detailSettled);
  };

  return {
    borders(task) {
      if (destroyed || bordersRequested) return;
      bordersRequested = true;
      run(task, () => {
        bordersSettled = true;
        const released = [...queued].map((entry) => entry.task);
        queued.clear();
        startDetails(released);
        considerStarfield();
      });
    },
    detail(task) {
      if (destroyed) return () => undefined;
      if (bordersSettled) {
        startDetails([task]);
        return () => undefined;
      }
      const entry = { task };
      queued.add(entry);
      return () => {
        queued.delete(entry);
      };
    },
    starfield(task) {
      if (destroyed || starfieldRequested) return;
      starfieldRequested = true;
      starfield = task;
      considerStarfield();
    },
    destroy() {
      destroyed = true;
      for (const stop of [...timers]) stop();
      queued.clear();
      starfield = null;
    },
  };
}
