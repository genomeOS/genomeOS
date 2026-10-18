/** Render-ready synchronization and visual swaps for Atlas design §11 (spec 2026-10-07 §B.6.8).
 *
 * Readiness is read after each rendered frame, and a hidden tab renders none, so a wait's idle
 * deadline counts visible time only (RF1), as the chunk scheduler's stall timeout does. Under World
 * Terrain (terrain draping design, "How existing features behave", #483) the worker prepares a
 * draped raster whether or not the tab is shown, so the wait for its tiles may begin hidden.
 * `whenLayerReady` waits the same way for one draped imagery layer (terrain draping design, "Per
 * layer under World Terrain"): a recoloured border or footprint layer, added at α 0, replaces the
 * shown one only once the globe has loaded its tiles or the layer's 3 s cap has passed.
 */

import type { Scene } from 'cesium';

import {
  DOCUMENT_VISIBILITY,
  type VisibilitySource,
} from './reveal-wave-driver';
import type { DrapedImageryLayer } from './types';

export interface SceneHost {
  scene: Pick<Scene, 'postRender' | 'primitives' | 'requestRender'>;
}

export interface FadeableGroup {
  collection: { show: boolean };
  /** The groups a `fadeTogether` unit stands for; a single group has none. */
  members?: readonly FadeableGroup[];
  isReady(): boolean;
  readyCount(): number;
  totalCount?(): number;
  setOpacity(opacity: number): void;
}

/** One fadeable unit for a surface and its observations, so a swap is atomic.
 *
 * Its `collection` is a view over the members' collections and is never in
 * the scene, so `animateSwap` removes each member's collection instead.
 */
export function fadeTogether(
  ...groups: (FadeableGroup | null | undefined)[]
): FadeableGroup | null {
  const members = groups.flatMap((group) =>
    group ? (group.members ?? [group]) : [],
  );
  if (members.length === 0) return null;
  return {
    members,
    collection: {
      get show() {
        return members.some((member) => member.collection.show);
      },
      set show(value: boolean) {
        for (const member of members) member.collection.show = value;
      },
    },
    isReady: () => members.every((member) => member.isReady()),
    readyCount: () =>
      members.reduce((total, member) => total + member.readyCount(), 0),
    setOpacity(opacity: number) {
      for (const member of members) member.setOpacity(opacity);
    },
    totalCount: () =>
      members.reduce(
        (total, member) =>
          total + (member.totalCount?.() ?? member.readyCount()),
        0,
      ),
  };
}

const HEATMAP_TRANSITION_MS = 720;
const HEATMAP_SWAP_MS = 300;
const GEOMETRY_IDLE_TIMEOUT_MS = 30_000;

export function transitionProgress(
  elapsedMs: number,
  durationMs = HEATMAP_TRANSITION_MS,
): number {
  const linear = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return linear * linear * (3 - 2 * linear);
}

export interface ReadyWaitOptions {
  /** Ends the wait with an AbortError, leaving the group as it is. */
  signal?: AbortSignal;
  /** Defaults to the document's. */
  visibility?: VisibilitySource;
}

function abortedWait(): DOMException {
  return new DOMException('The readiness wait was aborted', 'AbortError');
}

/**
 * Resolves once `group` is ready after a rendered frame. With no readiness progress in
 * `GEOMETRY_IDLE_TIMEOUT_MS` of visible time it hides the group and rejects: no timer runs while
 * the tab is hidden, and showing it again starts a whole window.
 */
export function waitForReady(
  viewer: SceneHost,
  group: FadeableGroup,
  onProgress?: (progress: number) => void,
  { signal, visibility = DOCUMENT_VISIBILITY }: ReadyWaitOptions = {},
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedWait());
  const totalCount = group.totalCount?.() ?? Math.max(group.readyCount(), 1);
  const report = () =>
    onProgress?.(
      totalCount === 0
        ? 1
        : Math.min(1, Math.max(0, group.readyCount() / totalCount)),
    );
  report();
  if (group.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let readyCount = group.readyCount();
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const stopWaiting = () => {
      clearTimeout(timeout);
      remove();
      removeVisibility();
      signal?.removeEventListener('abort', onAbort);
    };
    const failIfStalled = () => {
      group.collection.show = false;
      stopWaiting();
      reject(new Error('Cesium geometry build timed out'));
    };
    const onAbort = () => {
      stopWaiting();
      reject(abortedWait());
    };
    const extendDeadline = () => {
      clearTimeout(timeout);
      timeout = undefined;
      if (visibility.isHidden()) return;
      timeout = globalThis.setTimeout(
        // A page frozen while hidden may fire its timer late, on return.
        () => (visibility.isHidden() ? extendDeadline() : failIfStalled()),
        GEOMETRY_IDLE_TIMEOUT_MS,
      );
    };
    const remove = viewer.scene.postRender.addEventListener(() => {
      const nextReadyCount = group.readyCount();
      if (nextReadyCount > readyCount) {
        readyCount = nextReadyCount;
        report();
        extendDeadline();
      }
      if (!group.isReady()) return;
      stopWaiting();
      resolve();
    });
    const removeVisibility = visibility.onChange(extendDeadline);
    signal?.addEventListener('abort', onAbort, { once: true });
    extendDeadline();
    viewer.scene.requestRender();
  });
}

/**
 * Resolves after the first rendered frame at which `layer` is ready, requesting a frame after each
 * one until then, since a draped layer's tile loads request none of their own. An abort rejects
 * with an AbortError. Either way its one `postRender` listener is removed.
 */
export function whenLayerReady(
  layer: Pick<DrapedImageryLayer, 'isReady'>,
  scene: {
    postRender: { addEventListener(listener: () => void): () => void };
    requestRender(): void;
  },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedWait());
  return new Promise((resolve, reject) => {
    const settle = () => {
      remove();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(abortedWait());
    };
    const remove = scene.postRender.addEventListener(() => {
      if (!layer.isReady()) {
        scene.requestRender();
        return;
      }
      settle();
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
    scene.requestRender();
  });
}

export function animateSwap(
  viewer: SceneHost,
  incoming: FadeableGroup,
  outgoing: FadeableGroup | null,
  reducedMotion: boolean,
  retainOutgoing = false,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const retireOutgoing = () => {
    if (!outgoing) return;
    if (retainOutgoing) {
      outgoing.setOpacity(0);
      outgoing.collection.show = false;
    } else
      for (const group of outgoing.members ?? [outgoing])
        viewer.scene.primitives.remove(group.collection);
  };
  if (reducedMotion) {
    incoming.setOpacity(1);
    retireOutgoing();
    onProgress?.(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    onProgress?.(0);
    const frame = (now: number) => {
      const progress = transitionProgress(now - started, HEATMAP_SWAP_MS);
      onProgress?.(progress);
      incoming.setOpacity(progress);
      outgoing?.setOpacity(1 - progress);
      viewer.scene.requestRender();
      if (progress < 1) requestAnimationFrame(frame);
      else {
        retireOutgoing();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

export function animateValue(
  viewer: { scene: { requestRender(): void } },
  from: number,
  to: number,
  reducedMotion: boolean,
  update: (value: number) => void,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (reducedMotion || from === to) {
    if (shouldContinue()) {
      update(to);
      viewer.scene.requestRender();
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const frame = (now: number) => {
      if (!shouldContinue()) {
        resolve();
        return;
      }
      const progress = transitionProgress(now - started);
      update(from + (to - from) * progress);
      viewer.scene.requestRender();
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
