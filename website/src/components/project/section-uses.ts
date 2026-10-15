/**
 * "What it could be used for" (round 2 spec §4.2, applications), loaded when its section opens
 * (accordion.ts): the application glyphs draw in once, 90 ms apart (CSS keyed on
 * data-figure-state, applications.css); each replays its mechanism on hover.
 */
import {
  FigureController,
  type FigureControllerOptions,
} from '../../graphics/figure';

export function init(
  section: HTMLElement,
  options?: FigureControllerOptions,
): void {
  const figure = section.querySelector<HTMLElement>(
    'figure[data-graphic="applications"]',
  );
  if (figure)
    new FigureController(figure, { duration: 1100, rest() {} }, options);
}
