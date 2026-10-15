/**
 * "Where it stands" (round 2 spec §4.2.9), loaded when its section opens (accordion.ts): the
 * roadmap rail draws once, and an item and its node light each other. A tap has no hover to end
 * it, so a tapped pair stays lit until the next tap.
 */
import type { FigureControllerOptions } from '../../graphics/figure';
import { cssEntrance } from './entrance';

export function init(
  section: HTMLElement,
  options?: FigureControllerOptions,
): void {
  const figure = section.querySelector<HTMLElement>('[data-rail]');
  if (!figure) return;
  const marks = figure.querySelectorAll<HTMLElement>('[data-item],[data-node]');
  const key = (element: HTMLElement) =>
    element.dataset.item ?? element.dataset.node;
  const light = (lit?: string) => {
    for (const mark of marks)
      mark.classList.toggle('is-lit', !!lit && key(mark) === lit);
  };
  figure.addEventListener('pointerover', (event) => {
    const mark = (event.target as Element).closest<HTMLElement>(
      '[data-item],[data-node]',
    );
    if (mark) light(key(mark));
  });
  figure.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'touch') light();
  });
  cssEntrance(figure, 1100, options);
}
