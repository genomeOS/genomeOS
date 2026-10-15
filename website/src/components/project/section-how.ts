/**
 * "How it works" (round 2 spec §4.2.4–§4.2.8), loaded when its section opens (accordion.ts): the
 * join-up plate, the counts figure, the Pipeline (its kit island sets up every interactive
 * Pipeline on import) and the six safeguards, which CSS plays once, 120 ms apart; hovering one
 * replays it.
 */
import '../kit/pipeline';
import {
  prefersReducedMotion,
  type FigureControllerOptions,
} from '../../graphics/figure';
import { initCounts } from './counts';
import { cssEntrance } from './entrance';
import { initJoinUp } from './join-up';

const TILE_MS = 1600;

function initSafeguards(
  figure: HTMLElement,
  options?: FigureControllerOptions,
): void {
  const tiles = [...figure.querySelectorAll<HTMLElement>('.sg-tile')];
  cssEntrance(figure, TILE_MS + (tiles.length - 1) * 120, options);
  for (const tile of tiles) {
    let timer = 0;
    tile.addEventListener('pointerenter', () => {
      if (prefersReducedMotion() || figure.dataset.figureState !== 'rest')
        return;
      tile.classList.remove('is-replaying');
      void tile.offsetWidth;
      tile.classList.add('is-replaying');
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => tile.classList.remove('is-replaying'),
        TILE_MS,
      );
    });
  }
}

export function init(
  section: HTMLElement,
  options?: FigureControllerOptions,
): void {
  const pick = (selector: string) =>
    section.querySelector<HTMLElement>(selector);
  const joinUp = pick('[data-joinup]');
  if (joinUp) initJoinUp(joinUp, options);
  const counts = pick('figure[data-graphic="counts"]');
  if (counts) initCounts(counts, options);
  const safeguards = pick('[data-safeguards]');
  if (safeguards) initSafeguards(safeguards, options);
}
