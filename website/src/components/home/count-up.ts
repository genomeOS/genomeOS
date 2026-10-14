/** The evidence base's entrance (site redesign spec §4.1 H4, §2.7; #454): the three totals count
 * up over 900 ms while their composition bars grow (CSS, home.css), then rest on the values the
 * server already rendered. Tabular numerals keep every digit the same width, so nothing reflows.
 * Reduced motion, or a figure already on screen after 1.2 s, shows the final values at once. The
 * animated digits are for sight only (EvidenceBase.astro gives each total its final text too).
 *
 * Also home to `steadyEntrance`, which Home's frame-drawn entrances (this one and the hero globe)
 * share.
 */

import { FigureController, type FigureMotion } from '../../graphics/figure';
import { easeFigure } from '../../graphics/tween';

/**
 * A frame-drawn entrance on FigureController that cannot stall.
 *
 * FigureController draws a `render` entrance only through frames it schedules while it believes
 * the figure is on screen. When the play signal reaches a figure before its own on-screen observer
 * has reported it (a jump scroll onto a figure that loaded off screen), no frame is scheduled and
 * the figure stays in its "before" state for good (a blank globe, zeroed totals). So here the
 * controller keeps the state, the timing (its timer ends the entrance) and the rules (off screen,
 * hidden tab and print end it early), and the frames come from this loop, which runs only while
 * the controller says "playing". The dev-only `?t` freeze still draws through `render`.
 */
export function steadyEntrance(
  figure: HTMLElement,
  motion: Pick<FigureMotion, 'duration' | 'arm' | 'rest'> & {
    render(t: number): void;
  },
): FigureController {
  const frozen =
    import.meta.env.DEV &&
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('t');
  let frame = 0;
  const controller: FigureController = new FigureController(figure, {
    get duration() {
      return motion.duration;
    },
    arm: motion.arm,
    start() {
      if (frozen) return;
      const started = performance.now();
      const tick = (now: number) => {
        frame = 0;
        if (controller.state !== 'playing') return;
        motion.render(Math.max(0, now - started));
        frame = requestAnimationFrame(tick);
      };
      motion.render(0);
      frame = requestAnimationFrame(tick);
    },
    render: frozen ? (t) => motion.render(t) : undefined,
    rest() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      motion.rest();
    },
  });
  return controller;
}

export const COUNT_UP_MS = 900;

export type CountFormat = 'int' | 'millions';

/** "4,392"; "6.69M" (two decimals, as the page states the people total). */
export function formatCount(value: number, format: CountFormat): string {
  return format === 'millions'
    ? `${(value / 1e6).toFixed(2)}M`
    : Math.round(value).toLocaleString('en-US');
}

/** Counts the visible digits up. They are aria-hidden: the final values sit beside them, visually
 * hidden, so a screen reader that arrives before the entrance never reads a zero. */
export function initCountUp(figure: HTMLElement): void {
  const numbers = [
    ...figure.querySelectorAll<HTMLElement>('[data-count-to]'),
  ].map((element) => ({
    element,
    to: Number(element.dataset.countTo),
    format: (element.dataset.countFormat ?? 'int') as CountFormat,
    final: element.textContent ?? '',
  }));
  const show = (progress: number) => {
    for (const { element, to, format, final } of numbers)
      element.textContent =
        progress >= 1 ? final : formatCount(to * progress, format);
  };
  steadyEntrance(figure, {
    duration: COUNT_UP_MS,
    arm: () => show(0),
    render: (t) => show(easeFigure(Math.min(1, t / COUNT_UP_MS))),
    rest: () => show(1),
  });
}
