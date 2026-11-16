/** Small browser-runtime helpers for Atlas design §11. */

import type { ArtifactRef } from './contracts';
import { availableBasemaps, availableTerrains } from './earth-style-catalog';
import type { SceneCapabilities } from './scene/types';
import type { ExplorerState } from './url-state';

export const PUBLIC_SCENE_CAPABILITIES: SceneCapabilities = {
  basemaps: availableBasemaps(''),
  terrains: availableTerrains(''),
};

export function artifactVersion(ref: ArtifactRef): string {
  return `${ref.model_version}/${ref.data_version}`;
}

export function displayKey(
  state: ExplorerState,
  reducedMotion: boolean,
): string {
  return [state.view, state.elevation, state.exaggeration, reducedMotion].join(
    ':',
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected atlas error occurred.';
}

/**
 * Whether the browser has the WebGL API. It creates no context: creating one is a synchronous
 * round trip to the GPU process, which on a freshly launched browser waits behind the browser's
 * own first GPU pipeline compiles, and the scene lifecycle checks on every scene effect. A browser
 * that has the API but cannot create a context fails when Cesium starts, which the lifecycle also
 * reports as `webgl` (useAtlasSceneLifecycle.ts).
 */
export function supportsWebGL(): boolean {
  return (
    typeof WebGL2RenderingContext !== 'undefined' ||
    typeof WebGLRenderingContext !== 'undefined'
  );
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The reduced-motion preference at first render (Cesium globe design §12). The scene is built
 * with it, so reading it only in an effect would build a second globe for reduced-motion users.
 * The server cannot know it; no server-rendered markup depends on it, so hydration still matches.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}
