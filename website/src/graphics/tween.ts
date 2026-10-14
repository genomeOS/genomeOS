/** A requestAnimationFrame tween that stops itself (site redesign spec §2.7, #454).
 *
 * Figures animate a mark group from 0 to 1 over a duration, then rest: the tween schedules no
 * frame once it has finished or been cancelled. The easing curves match the CSS tokens
 * `--ease-ui`, `--ease-figure` and `--ease-camera` (tokens.css).
 */

export type Ease = (t: number) => number;

/** Cubic Bézier easing with control points (x1, y1) and (x2, y2), as CSS defines it. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Ease {
  const curve = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let step = 0; step < 8; step += 1) {
      const error = curve(x1, x2, t) - x;
      const gradient = slope(x1, x2, t);
      if (Math.abs(error) < 1e-6 || gradient === 0) break;
      t = Math.min(1, Math.max(0, t - error / gradient));
    }
    return curve(y1, y2, t);
  };
}

export const easeUi = cubicBezier(0.2, 0.75, 0.25, 1);
export const easeFigure = cubicBezier(0.2, 0.72, 0.2, 1);
export const easeCamera = cubicBezier(0.65, 0, 0.35, 1);
export const linear: Ease = (t) => t;

/** Frame scheduling a figure supplies so its tweens stop with it (FigureController.frame). */
export type FrameScheduler = (callback: FrameRequestCallback) => number;

export interface Tween {
  /** Resolves when the tween reaches 1, or when it is cancelled. */
  done: Promise<void>;
  cancel(): void;
}

/**
 * Call `onFrame(eased, linearProgress)` on every frame for `ms`, then once more at 1, then stop.
 * A cancelled tween calls nothing further.
 */
export function tween(
  ms: number,
  onFrame: (eased: number, progress: number) => void,
  ease: Ease = easeFigure,
  schedule: FrameScheduler = (callback) => requestAnimationFrame(callback),
): Tween {
  let cancelled = false;
  let resolve!: () => void;
  const done = new Promise<void>((settle) => (resolve = settle));
  if (ms <= 0) {
    onFrame(1, 1);
    resolve();
    return { done, cancel: () => undefined };
  }
  let start: number | null = null;
  const step = (now: number) => {
    if (cancelled) return;
    start ??= now;
    const progress = Math.min(1, (now - start) / ms);
    onFrame(ease(progress), progress);
    if (progress < 1) schedule(step);
    else resolve();
  };
  schedule(step);
  return {
    done,
    cancel() {
      cancelled = true;
      resolve();
    },
  };
}
