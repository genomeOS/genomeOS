/**
 * Tells the scene how much of the globe canvas the persistent controls panel covers, so the
 * desktop globe is drawn centred in the open area beside it (fast-load design §A.1.13, amended
 * 2026-10-13; #452). The island measures, because it owns the panel; the scene only receives a
 * width through `AtlasSceneController.setLeftObstruction` and never reads the explorer's DOM. Only
 * the controls panel counts: the inspector and other transient panels do not move the globe.
 * Cesium-free.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import type { AtlasSceneController } from '../../atlas/scene/types';
import { coveredCanvasWidth } from '../../atlas/view-offset';
import { MOBILE_QUERY, useMediaQuery } from './useMediaQuery';

export interface ObstructionObservers {
  MutationObserver: typeof MutationObserver;
  ResizeObserver: typeof ResizeObserver;
}

interface ObstructionTarget {
  canvas: HTMLElement | null;
  panel: HTMLElement | null;
  phone: boolean;
}

function browserObservers(): ObstructionObservers {
  return { MutationObserver, ResizeObserver };
}

/** The covered width now; 0 in the phone layout or without both elements. */
function measureControlsObstruction({
  canvas,
  panel,
  phone,
}: ObstructionTarget): number {
  if (phone || !canvas || !panel) return 0;
  return coveredCanvasWidth({
    canvas: canvas.getBoundingClientRect(),
    // `hidden` may also be 'until-found', which hides the panel too.
    hidden: Boolean(panel.hidden),
    panel: panel.getBoundingClientRect(),
    phone,
  });
}

/**
 * Reports the covered width now and whenever the panel or the canvas resizes or the panel's
 * `hidden` flag changes; returns the cleanup. A phone layout or a missing element reports 0.
 */
export function observeControlsObstruction(
  target: ObstructionTarget,
  report: (width: number) => void,
  observers: ObstructionObservers = browserObservers(),
): () => void {
  const { canvas, panel, phone } = target;
  if (phone || !canvas || !panel) {
    report(0);
    return () => undefined;
  }
  let reported: number | null = null;
  const measure = () => {
    const width = measureControlsObstruction(target);
    if (width === reported) return;
    reported = width;
    report(width);
  };
  const resize = new observers.ResizeObserver(measure);
  resize.observe(panel);
  resize.observe(canvas);
  const hidden = new observers.MutationObserver(measure);
  hidden.observe(panel, { attributeFilter: ['hidden'], attributes: true });
  measure();
  return () => {
    resize.disconnect();
    hidden.disconnect();
  };
}

/**
 * Keeps the scene's left obstruction current, and returns a measurement of it on demand: a new
 * scene is given it when bound, before its first frame, so the globe never starts at the canvas
 * centre and jumps.
 */
export function useGlobeOffset(
  panel: HTMLElement | null,
  canvas: RefObject<HTMLElement | null>,
  controller: Pick<AtlasSceneController, 'setLeftObstruction'> | null,
): () => number {
  const phone = useMediaQuery(MOBILE_QUERY);
  const latest = useRef({ panel, phone });
  latest.current = { panel, phone };
  useEffect(() => {
    if (!controller) return;
    return observeControlsObstruction(
      { canvas: canvas.current, panel, phone },
      (width) => controller.setLeftObstruction(width),
    );
  }, [canvas, controller, panel, phone]);
  return useCallback(
    () =>
      measureControlsObstruction({ canvas: canvas.current, ...latest.current }),
    [canvas],
  );
}
