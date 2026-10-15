/**
 * A CSS-keyed entrance, played once (site redesign spec §2.7; round 2 spec §4.2): the controller
 * adds `is-armed` (the before state, screens only), then `is-playing`, whose keyframes read `--d`
 * for their delays (projects.css). Shared by the section modules (section-*.ts), which create
 * their figures' controllers only when a section opens.
 */
import {
  FigureController,
  type FigureControllerOptions,
} from '../../graphics/figure';

export const cssEntrance = (
  figure: HTMLElement,
  duration: number,
  options?: FigureControllerOptions,
): FigureController =>
  new FigureController(
    figure,
    {
      duration,
      arm: () => figure.classList.add('is-armed'),
      start: () => {
        figure.classList.remove('is-armed');
        figure.classList.add('is-playing');
      },
      rest: () => figure.classList.remove('is-armed', 'is-playing'),
    },
    options,
  );
