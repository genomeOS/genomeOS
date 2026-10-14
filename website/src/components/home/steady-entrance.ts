/** A frame-drawn entrance that cannot stall (site redesign spec §2.7; #454), for the hero globe.
 *
 * (The evidence base's count-up used it too until the design review's round 1: its armed state
 * read 0 / 0.00M / 0 while partly in view, so its totals are static text now and only its bars
 * grow, in CSS.)
 */

import { FigureController, type FigureMotion } from '../../graphics/figure';

/**
 * A frame-drawn entrance on FigureController that cannot stall.
 *
 * FigureController draws a `render` entrance only through frames it schedules while it believes
 * the figure is on screen. When the play signal reaches a figure before its own on-screen observer
 * has reported it (a jump scroll onto a figure that loaded off screen), no frame is scheduled and
 * the figure stays in its "before" state for good (a blank globe). So here the controller keeps the
 * state, the timing (its timer ends the entrance) and the rules (off screen, hidden tab and print
 * end it early), and the frames come from this loop, which runs only while the controller says
 * "playing". The dev-only `?t` freeze still draws through `render`.
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
