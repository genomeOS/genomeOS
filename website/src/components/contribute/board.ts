/** "How work moves": the work board's island (site redesign spec §4.3 C3, §2.7, #454).
 *
 * - The step tabs become a roving tablist (`graphics/tabs.ts`) and the five panels its tabpanels.
 * - The tour plays once when the board is 35% visible: steps 1 to 5, 1.2 s each, the example card
 *   moving 450 ms between places on `--ease-camera`; then it rests on step 5. Any choice the
 *   visitor makes ends the tour on the step they chose. Places, lines and stage names come from
 *   the server-rendered board, so the island ships no copy.
 * - Reduced motion: no tour; step 1 is selected and every change is instant.
 *
 * At every moment one tab is selected, one card is shown, one place is lit and at most one column
 * definition line shows, and all four name the same step. Tours never announce: there is no live
 * region, and the stage's name follows the step for anyone who reads it.
 */

import { FigureController, prefersReducedMotion } from '../../graphics/figure';
import { initTabs, type TabsChangeDetail } from '../../graphics/tabs';
import { CARD_MOVE_MS, REDUCED_STEP, STEP_MS } from './board-steps';

const EASE_CAMERA = 'cubic-bezier(0.65, 0, 0.35, 1)';

function initBoard(figure: HTMLElement): void {
  const board = figure.querySelector<HTMLElement>('.wb')!;
  const stage = figure.querySelector<HTMLElement>('[data-figure-stage]')!;
  const list = figure.querySelector<HTMLElement>('[role="tablist"]')!;
  const panels = figure.querySelector<HTMLOListElement>('.wb-panels')!;
  const places = [...board.querySelectorAll<HTMLElement>('.wb-place')];
  const cards = [...board.querySelectorAll<HTMLElement>('.wb-card')];
  const definitions = [
    ...board.querySelectorAll<HTMLElement>('[data-definition]'),
  ];
  const labels = JSON.parse(figure.dataset.wbLabels ?? '[]') as string[];
  const reduced = prefersReducedMotion();
  // One card per step, in step order: step n's card names its place.
  const steps = cards.length;
  const placeOf = (n: number) => cards[n - 1].dataset.at;

  // The ordered list becomes the tabs' panels; without this script it stays a list.
  panels.setAttribute('role', 'none');
  panels.querySelectorAll('li').forEach((item, index) => {
    item.setAttribute('role', 'none');
    const panel = item.querySelector<HTMLElement>('.wb-panel')!;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `wb-tab-${index + 1}`);
  });
  list.hidden = false;
  const tabs = initTabs(list);
  figure.classList.add('is-enhanced');

  let shown = Number(board.dataset.step);
  let chosen: number | null = null;

  /** What marks the card's place: the card on a wide stage, its marker on a narrow one. */
  const marks = () => [
    cards.find((card) => !card.hidden),
    board.querySelector<HTMLElement>('.wb-place.is-here .wb-marker'),
  ];

  /** Show step `n` everywhere at once; `move` slides the card (or marker) from where it was. */
  function show(n: number, move: boolean): void {
    const at = placeOf(n);
    const before = marks().map((mark) => mark?.getBoundingClientRect());
    board.dataset.step = String(n);
    for (const card of cards) card.hidden = card.dataset.at !== at;
    for (const place of places)
      place.classList.toggle('is-here', place.dataset.place === at);
    for (const line of definitions)
      line.hidden = line.dataset.definition !== at;
    if (labels[n - 1]) stage.setAttribute('aria-label', labels[n - 1]);
    if (tabs.selected !== n - 1) tabs.select(n - 1);
    shown = n;
    if (!move || reduced) return;
    marks().forEach((mark, index) => {
      const from = before[index];
      if (!mark || !from || from.width === 0) return;
      const to = mark.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (to.width === 0 || Math.hypot(dx, dy) < 1) return;
      mark.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: CARD_MOVE_MS, easing: EASE_CAMERA },
      );
    });
  }

  // The tour steps on timers, so it needs no animation frames; the controller's clock ends it,
  // early too when the board leaves the screen or the tab hides.
  let timers: number[] = [];
  const controller = new FigureController(figure, {
    duration: STEP_MS * steps,
    arm() {
      show(1, false);
    },
    start() {
      for (let n = 2; n <= steps; n += 1)
        timers.push(window.setTimeout(() => show(n, true), (n - 1) * STEP_MS));
    },
    rest() {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = [];
      const n = chosen ?? (reduced ? REDUCED_STEP : steps);
      if (n !== shown) show(n, chosen !== null);
    },
  });

  list.addEventListener('tabs:change', (event) => {
    const { index, user } = (event as CustomEvent<TabsChangeDetail>).detail;
    if (!user) return;
    chosen = index + 1;
    // Any choice ends the tour (or stops it from starting) on the chosen step.
    if (controller.state !== 'rest') controller.finish();
    else show(chosen, true);
  });
}

for (const figure of document.querySelectorAll<HTMLElement>(
  '[data-graphic="work-board"]',
))
  initBoard(figure);
