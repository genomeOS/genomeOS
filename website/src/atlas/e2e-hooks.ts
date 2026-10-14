/**
 * Test-only hooks for the e2e build (fast-load design §B.8; #453). Each is inert unless the build
 * sets `PUBLIC_ATLAS_E2E_HOOKS=1`, which only `npm run build:e2e` may do (`assertE2eHooks`,
 * lib/catalog-build.ts), so no production build carries them.
 */

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
  }
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
