/**
 * Tells the scene how much of the globe canvas the persistent controls panel covers, so the
 * desktop globe is drawn centred in the open area beside it (fast-load design §A.1.13, amended
 * 2026-10-13; #452). The island measures, because it owns the panel; the scene only receives a
 * width through `AtlasSceneController.setLeftObstruction` and never reads the explorer's DOM. Only
 * the controls panel counts: the inspector and other transient panels do not move the globe.
 * Cesium-free.
 */

import { useEffect, type RefObject } from 'react';

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

/**
 * Reports the covered width now and whenever the panel or the canvas resizes or the panel's
 * `hidden` flag changes; returns the cleanup. A phone layout or a missing element reports 0.
 */
export function observeControlsObstruction(
  { canvas, panel, phone }: ObstructionTarget,
  report: (width: number) => void,
  observers: ObstructionObservers = browserObservers(),
): () => void {
  if (phone || !canvas || !panel) {
    report(0);
    return () => undefined;
  }
  let reported: number | null = null;
  const measure = () => {
    const width = coveredCanvasWidth({
      canvas: canvas.getBoundingClientRect(),
      // `hidden` may also be 'until-found', which hides the panel too.
      hidden: Boolean(panel.hidden),
      panel: panel.getBoundingClientRect(),
      phone: false,
    });
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

export function useGlobeOffset(
  panel: HTMLElement | null,
  canvas: RefObject<HTMLElement | null>,
  controller: Pick<AtlasSceneController, 'setLeftObstruction'> | null,
): void {
  const phone = useMediaQuery(MOBILE_QUERY);
  useEffect(() => {
    if (!controller) return;
    return observeControlsObstruction(
      { canvas: canvas.current, panel, phone },
      (width) => controller.setLeftObstruction(width),
    );
  }, [canvas, controller, panel, phone]);
}
