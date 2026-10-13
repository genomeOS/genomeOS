/**
 * Test-only hooks for the e2e build (fast-load design §B.8; #453). Each is inert unless the build
 * sets `PUBLIC_ATLAS_E2E_HOOKS=1`, which only `npm run build:e2e` may do (`assertE2eHooks`,
 * lib/catalog-build.ts), so no production build carries them.
 */

declare global {
  interface Window {
    /**
     * The progress (0 to 1) at which a browser test holds the surface reveal wave, so it can
     * sample a frame mid-wave; unset or null lets the wave run.
     */
    __atlasRevealWaveHold?: number | null;
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
